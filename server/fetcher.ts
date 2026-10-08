// All outbound HTTP goes through here: host allowlist, blocked domains, per-host rate limit,
// timeouts, body cap, robots.txt, and a 30-day body cache.
import fs from "node:fs";
import path from "node:path";
import { CACHE_DIR, USER_AGENT } from "./config.ts";
import { sha256 } from "./db.ts";
import { log } from "./log.ts";

export const API_HOSTS = new Set([
  "api.openai.com", "www.sefaria.org", "sefaria.org", "api.x.com",
  "github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com", "raw.githubusercontent.com", "api.github.com",
  "a.openbible.info", "bible.helloao.org", "beta.ourmanna.com", "www.bible.com",
  // Skip Heitzig's devotionals, through the site's public WordPress API (a JSON endpoint, so not a "page").
  "connectwithskip.com",
]);

let blockedHosts: Set<string> = new Set();
export function setBlockedHosts(hosts: string[]) {
  blockedHosts = new Set(hosts.map((h) => h.toLowerCase()));
}
export function isBlocked(host: string): boolean {
  const h = host.toLowerCase();
  for (const b of blockedHosts) if (h === b || h.endsWith("." + b)) return true;
  return false;
}

const lastHit = new Map<string, number>();
async function rateLimit(host: string) {
  if (API_HOSTS.has(host)) return;
  const last = lastHit.get(host) ?? 0;
  const wait = last + 1000 - Date.now();
  lastHit.set(host, Math.max(Date.now(), last + 1000));
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

export class FetchError extends Error {
  status: number | null;
  url: string;
  constructor(url: string, status: number | null, message: string) {
    super(message);
    this.url = url;
    this.status = status;
  }
}

export interface FetchOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxBytes?: number;
  cacheDays?: number; // 0 = no cache
  page?: boolean; // a candidate web page (robots.txt, blocked list, html/text only)
  signal?: AbortSignal;
  retries?: number;
}

const robotsCache = new Map<string, { at: number; disallow: string[] }>();
async function robotsAllows(u: URL): Promise<boolean> {
  const key = u.host;
  let entry = robotsCache.get(key);
  if (!entry || Date.now() - entry.at > 24 * 3600_000) {
    let disallow: string[] = [];
    try {
      const res = await fetch(`${u.protocol}//${u.host}/robots.txt`, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(8000) });
      if (res.ok && (res.headers.get("content-type") ?? "").includes("text/plain")) {
        const text = await res.text();
        let applies = false;
        for (const line of text.split(/\r?\n/)) {
          const [k, ...rest] = line.split(":");
          const v = rest.join(":").trim();
          if (/^user-agent$/i.test(k.trim())) applies = v === "*" || v.toLowerCase().startsWith("personalcommentary");
          else if (applies && /^disallow$/i.test(k.trim()) && v) disallow.push(v);
        }
      }
    } catch {
      disallow = [];
    }
    entry = { at: Date.now(), disallow };
    robotsCache.set(key, entry);
  }
  return !entry.disallow.some((p) => u.pathname.startsWith(p));
}

function cachePath(url: string) {
  return path.join(CACHE_DIR, sha256(url) + ".json");
}

export interface FetchedText {
  url: string;
  finalUrl: string;
  status: number;
  contentType: string;
  body: string;
  fromCache: boolean;
}

export async function fetchText(url: string, opts: FetchOptions = {}): Promise<FetchedText> {
  const u = new URL(url);
  if (u.protocol !== "https:") throw new FetchError(url, null, "Only HTTPS addresses are fetched.");
  if (!opts.page && !API_HOSTS.has(u.host)) throw new FetchError(url, null, `${u.host} isn't on the allowlist.`);
  if (isBlocked(u.host)) throw new FetchError(url, null, `${u.host} is on your blocked list.`);

  const cacheDays = opts.cacheDays ?? 0;
  if (cacheDays > 0) {
    try {
      const c = JSON.parse(fs.readFileSync(cachePath(url), "utf8"));
      if (Date.now() - Date.parse(c.fetchedAt) < cacheDays * 86400_000) return { ...c.res, fromCache: true };
    } catch {
      /* miss */
    }
  }
  if (opts.page && !(await robotsAllows(u))) throw new FetchError(url, null, `${u.host}'s robots.txt asks tools not to fetch this page.`);

  const retries = opts.retries ?? 3;
  const backoff = [1000, 4000, 10000];
  let lastErr: unknown;
  for (let attempt = 0; attempt < retries; attempt++) {
    await rateLimit(u.host);
    const started = Date.now();
    try {
      const timeout = AbortSignal.timeout(opts.timeoutMs ?? 20_000);
      const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
      const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, ...(opts.headers ?? {}) }, redirect: "follow", signal });
      const finalHost = new URL(res.url || url).host;
      if (isBlocked(finalHost)) throw new FetchError(url, res.status, `Redirected to blocked host ${finalHost}.`);
      const ct = res.headers.get("content-type") ?? "";
      log("info", "fetch", "response", { host: u.host, status: res.status, ms: Date.now() - started });
      if ((res.status === 429 || res.status >= 500) && attempt < retries - 1) {
        const ra = Number(res.headers.get("retry-after"));
        await new Promise((r) => setTimeout(r, (ra > 0 ? ra * 1000 : backoff[attempt]) + Math.random() * 300));
        continue;
      }
      if (opts.page && !/text\/html|text\/plain|application\/xhtml/.test(ct)) throw new FetchError(url, res.status, `Not a web page (${ct || "unknown type"}).`);
      const buf = await readCapped(res, opts.maxBytes ?? 2 * 1024 * 1024);
      const body = new TextDecoder("utf-8").decode(buf);
      const out: FetchedText = { url, finalUrl: res.url || url, status: res.status, contentType: ct, body, fromCache: false };
      if (!res.ok) throw new FetchError(url, res.status, `${u.host} answered ${res.status}.`);
      if (cacheDays > 0) fs.writeFileSync(cachePath(url), JSON.stringify({ fetchedAt: new Date().toISOString(), res: out }));
      return out;
    } catch (e) {
      lastErr = e;
      if (e instanceof FetchError) throw e;
      if (opts.signal?.aborted) throw e;
      if (attempt < retries - 1) await new Promise((r) => setTimeout(r, backoff[attempt]));
    }
  }
  const msg = lastErr instanceof Error && lastErr.name === "TimeoutError" ? `${u.host} didn't answer in time.` : `${u.host} couldn't be reached.`;
  throw new FetchError(url, null, msg);
}

async function readCapped(res: Response, max: number): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel();
      throw new FetchError(res.url, res.status, "The page is larger than 2 MB.");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

export async function fetchJson<T = any>(url: string, opts: FetchOptions = {}): Promise<T> {
  const r = await fetchText(url, { ...opts, headers: { Accept: "application/json", ...(opts.headers ?? {}) } });
  return JSON.parse(r.body) as T;
}

/** Private provider requests: never cached, redirected, or automatically retried. */
export async function fetchOpenai(endpoint: string, key: string, opts: { body?: unknown; signal?: AbortSignal } = {}): Promise<Response> {
  if (!/^\/(responses|models\/[a-zA-Z0-9.-]+)$/.test(endpoint)) throw new FetchError(endpoint, null, "Unsupported OpenAI endpoint.");
  let base = "https://api.openai.com/v1";
  const override = process.env.COMMENTARY_OPENAI_BASE_URL;
  if (override) {
    const u = new URL(override);
    const local = ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
    if ((process.env.COMMENTARY_TEST !== "1" && process.env.COMMENTARY_DEMO !== "1") || !local || u.username || u.password || u.search || u.hash || !["http:", "https:"].includes(u.protocol)) {
      throw new FetchError(override, null, "The test OpenAI endpoint must be local and enabled only for tests or the demo.");
    }
    base = override.replace(/\/$/, "");
  }
  const url = base + endpoint;
  if (isBlocked(new URL(url).hostname)) throw new FetchError(url, null, "OpenAI is on your blocked list.");
  const timeout = AbortSignal.timeout(opts.body ? 8 * 60_000 : 20_000);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  const res = await fetch(url, {
    method: opts.body ? "POST" : "GET",
    headers: { "User-Agent": USER_AGENT, Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: opts.body ? "text/event-stream" : "application/json" },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    redirect: "error", signal,
  });
  // Bound both streaming completions and error bodies without buffering the response first.
  let bytes = 0;
  const body = res.body?.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      bytes += chunk.byteLength;
      if (bytes > 8 * 1024 * 1024) throw new FetchError(url, res.status, "OpenAI's response exceeded the local size limit.");
      controller.enqueue(chunk);
    },
  }));
  return new Response(body ?? null, { status: res.status, statusText: res.statusText, headers: res.headers });
}

/** Downloads a large file to disk (datasets). Allowlisted hosts only. */
export async function downloadFile(url: string, dest: string, onProgress?: (received: number, total: number | null) => void) {
  const u = new URL(url);
  if (!API_HOSTS.has(u.host)) throw new FetchError(url, null, `${u.host} isn't on the allowlist.`);
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT }, redirect: "follow" });
  if (!res.ok || !res.body) throw new FetchError(url, res.status, `Download failed (${res.status}).`);
  const total = Number(res.headers.get("content-length")) || null;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = dest + ".part";
  const out = fs.createWriteStream(tmp);
  let received = 0;
  const reader = res.body.getReader();
  let lastEmit = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.length;
    if (!out.write(value)) await new Promise((r) => out.once("drain", r));
    if (onProgress && Date.now() - lastEmit > 300) {
      lastEmit = Date.now();
      onProgress(received, total);
    }
  }
  await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
  fs.renameSync(tmp, dest);
  onProgress?.(received, total);
}
