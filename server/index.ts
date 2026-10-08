// Personal Commentary' local server: 127.0.0.1 only, Host checks against DNS rebinding, and a per-process
// capability token on every mutation.
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { APP_NAME, DATA_DIR, PORTS, ROOT } from "./config.ts";
import { openDb } from "./db.ts";
import { seed } from "./seed.ts";
import { registerRoutes } from "./routes.ts";
import { recoverInterruptedRuns } from "./pipeline.ts";
import { setBlockedHosts } from "./fetcher.ts";
import { log } from "./log.ts";
import { scheduleBackups } from "./backup.ts";
import { getPrefs } from "./prefs.ts";
import { downloadDataset } from "./datasets.ts";
import { stepbibleAvailable } from "./sources/stepbible.ts";
import { runRepairs } from "./repair.ts";

const CAPABILITY = crypto.randomBytes(32).toString("hex");
/** COMMENTARY_WEB_DIR lets a sandbox serve its own build without touching the one the Mac app serves. */
const WEB_DIR = process.env.COMMENTARY_WEB_DIR ?? path.join(ROOT, "dist", "web");

async function freePort(): Promise<number> {
  const requested = Number(process.env.COMMENTARY_PORT);
  const candidates = requested ? [requested] : PORTS;
  for (const p of candidates) {
    const ok = await new Promise<boolean>((resolve) => {
      const s = net.createServer();
      s.once("error", () => resolve(false));
      s.listen(p, "127.0.0.1", () => s.close(() => resolve(true)));
    });
    if (ok) return p;
  }
  throw new Error(`No free port in ${candidates[0]}–${candidates.at(-1)}.`);
}

export async function buildApp(port: number, dbFile?: string) {
  const db = openDb(dbFile);
  seed(db);
  recoverInterruptedRuns(db);
  setBlockedHosts((db.prepare("SELECT host FROM domains WHERE policy = 'blocked'").all() as any[]).map((r) => r.host));

  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });
  const origins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

  app.addHook("onRequest", async (req, reply) => {
    if (!hosts.has(req.headers.host ?? "")) return reply.code(421).send({ error: "Misdirected request." });
    if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
      if (!origins.has(req.headers.origin ?? "")) return reply.code(403).send({ error: "Cross-origin request refused." });
      if (req.headers["x-app-capability"] !== CAPABILITY) return reply.code(403).send({ error: "Missing capability. Reload the page." });
    }
  });
  app.addHook("onSend", async (_req, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("X-Frame-Options", "DENY");
    return payload;
  });

  registerRoutes(app, db);

  const indexHtml = () => {
    const file = path.join(WEB_DIR, "index.html");
    if (!fs.existsSync(file)) return `<!doctype html><title>${APP_NAME}</title><body style="font-family:system-ui;padding:40px">The web app isn't built yet. Run <code>npm run build</code>.</body>`;
    return fs.readFileSync(file, "utf8").replace("__COMMENTARY_CAPABILITY__", CAPABILITY);
  };
  if (fs.existsSync(WEB_DIR)) {
    await app.register(fastifyStatic, { root: WEB_DIR, prefix: "/", index: false, wildcard: true });
  }
  app.get("/", (_req, reply) => reply.type("text/html").header("Cache-Control", "no-store").send(indexHtml()));
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith("/api/")) return reply.code(404).send({ error: "Not found." });
    if (/\.\w+$/.test(req.url.split("?")[0])) return reply.code(404).send("Not found");
    return reply.type("text/html").header("Cache-Control", "no-store").send(indexHtml()); // client-side routes
  });
  return { app, db };
}

// Under the Mac app (COMMENTARY_MANAGED=1), stdout carries one JSON line per event, and the app holds stdin open:
// EOF means the app quit or crashed, so the server shuts down with it.
const MANAGED = process.env.COMMENTARY_MANAGED === "1";
const announce = (event: Record<string, string>) => process.stdout.write(JSON.stringify(event) + "\n");

async function main() {
  const port = await freePort();
  const { app, db } = await buildApp(port);
  scheduleBackups(db);
  await app.listen({ host: "127.0.0.1", port });
  void runRepairs(db);
  // The Hebrew and Greek words arrived after many installs; fetch them once, quietly, for anyone already set up.
  if (getPrefs(db).onboarded && !stepbibleAvailable()) void downloadDataset("stepbible");
  const portFile = path.join(DATA_DIR, "port");
  fs.writeFileSync(portFile, String(port));
  log("info", "server", "listening", { port, managed: MANAGED });

  let stopping = false;
  const shutdown = async (why: string) => {
    if (stopping) return;
    stopping = true;
    log("info", "server", "stopping", { why });
    // Let in-flight saves finish; open event streams would hold close() forever, so cap the wait.
    await Promise.race([app.close(), new Promise((r) => setTimeout(r, 3000))]);
    db.close();
    try {
      if (fs.readFileSync(portFile, "utf8") === String(port)) fs.rmSync(portFile);
    } catch {
      /* already gone */
    }
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  if (MANAGED) {
    process.stdin.on("end", () => void shutdown("app closed"));
    process.stdin.resume();
    announce({ event: "ready", url: `http://127.0.0.1:${port}/` });
  } else {
    console.log(`${APP_NAME} is running at http://127.0.0.1:${port}`);
  }
}

if (process.env.COMMENTARY_TEST !== "1") {
  await main().catch((e) => {
    log("error", "server", "start_failed", { error: String(e) });
    if (MANAGED) announce({ event: "error", message: `${APP_NAME} couldn't start: ${e instanceof Error ? e.message : String(e)}` });
    else console.error(e);
    process.exit(1);
  });
}

export { CAPABILITY };
