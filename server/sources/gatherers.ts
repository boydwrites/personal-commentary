// Deterministic gathering stages G1–G4. No model calls here.
import fs from "node:fs";
import Database from "better-sqlite3";
import { unzipSync, strFromU8 } from "fflate";
import { parseHTML } from "linkedom";
import { DATASET_PATHS } from "../config.ts";
import { fetchJson, fetchText } from "../fetcher.ts";
import { bookByName, bookByUsfm, fromOpenBible, toBibleHubVerseUrl, toHcfLocation, toOpenBible, type PassageRange } from "../../shared/refs.ts";
import { verseCount } from "../bible.ts";

type Range = { book: string; c1: number; v1: number; c2: number; v2: number };

// ---------- G1: Historical Christian Faith commentary database ----------
export interface HcfRow {
  id: string;
  father_name: string;
  append_to_author_name: string | null;
  ts: number;
  location_start: number;
  location_end: number;
  txt: string;
  source_url: string | null;
  source_title: string | null;
  condemned: number;
  priority: 1 | 2 | 3;
}

let hcfDb: Database.Database | null = null;
export function hcfAvailable() {
  return fs.existsSync(DATASET_PATHS.hcf);
}
function hcf() {
  if (!hcfDb) hcfDb = new Database(DATASET_PATHS.hcf, { readonly: true, fileMustExist: true });
  return hcfDb;
}
export function closeHcf() {
  hcfDb?.close();
  hcfDb = null;
}

/**
 * Window W1: the study's verses (priority 1), then the rest of the chapter (priority 2).
 * W2 adds the previous and next chapters (priority 3). Ranked: preferred in p1, preferred in p2, others in p1.
 */
export function gatherHcf(r: Range, preferred: { names: string[]; rank: number }[], deeper: boolean, limit = 12): HcfRow[] {
  const b = bookByUsfm(r.book)!;
  const lo = deeper ? Math.max(1, r.c1 - 1) : r.c1;
  const hi = deeper ? r.c2 + 1 : r.c2;
  const rows = hcf()
    .prepare(
      `SELECT c.id, c.father_name, c.append_to_author_name, c.ts, c.location_start, c.location_end, c.txt, c.source_url, c.source_title,
              COALESCE(m.condemned_by_council, 0) AS condemned
         FROM commentary c LEFT JOIN father_meta m ON m.name = c.father_name
        WHERE c.book = ? AND c.location_start <= ? AND c.location_end >= ?
        ORDER BY c.ts`,
    )
    .all(b.hcf, toHcfLocation(hi, 999), toHcfLocation(lo, 0)) as Omit<HcfRow, "priority">[];
  const startLoc = toHcfLocation(r.c1, r.v1);
  const endLoc = toHcfLocation(r.c2, r.v2);
  const rankOf = new Map<string, number>();
  for (const p of preferred) for (const n of p.names) rankOf.set(n, p.rank);

  const scored = rows
    .map((row) => {
      const inVerses = row.location_start <= endLoc && row.location_end >= startLoc;
      const inChapter = Math.floor(row.location_start / 1_000_000) <= r.c2 && Math.floor(row.location_end / 1_000_000) >= r.c1;
      const priority = (inVerses ? 1 : inChapter ? 2 : 3) as 1 | 2 | 3;
      return { ...row, priority };
    })
    // Some rows attribute a scriptural allusion to a book ("Romans"); those aren't interpreters.
    .filter((row) => !bookByName(row.father_name))
    .filter((row) => !row.condemned || rankOf.has(row.father_name));

  const pref = (row: HcfRow) => rankOf.get(row.father_name);
  const bucket = (row: HcfRow) => {
    const p = pref(row) !== undefined;
    if (p && row.priority === 1) return 0;
    if (p && row.priority === 2) return 1;
    if (!p && row.priority === 1) return 2;
    if (p && row.priority === 3) return 3;
    if (!p && row.priority === 2) return 4;
    return 5;
  };
  scored.sort((a, b2) => bucket(a) - bucket(b2) || (pref(a) ?? 99) - (pref(b2) ?? 99) || a.ts - b2.ts);
  // Keep variety: at most two rows per author.
  const perAuthor = new Map<string, number>();
  const out: HcfRow[] = [];
  for (const row of scored) {
    const n = perAuthor.get(row.father_name) ?? 0;
    if (n >= 2) continue;
    perAuthor.set(row.father_name, n + 1);
    out.push(row);
    if (out.length >= limit) break;
  }
  return out;
}

export function hcfLocLabel(row: { location_start: number; location_end: number }) {
  const c1 = Math.floor(row.location_start / 1_000_000);
  const v1 = row.location_start % 1_000_000;
  const c2 = Math.floor(row.location_end / 1_000_000);
  const v2 = row.location_end % 1_000_000;
  if (c1 === c2 && v1 === v2) return `${c1}:${v1}`;
  if (c1 === c2) return `${c1}:${v1}–${v2}`;
  return `${c1}:${v1}–${c2}:${v2}`;
}

// ---------- G2: Sefaria (Old Testament only) ----------
// English and Hebrew verse numbering differ in these chapters; until the STEPBible mapping lands,
// Jewish commentary is skipped there and the gap is recorded.
const DIVERGENT: Record<string, number[] | "all"> = {
  PSA: "all", JOL: [2, 3], MAL: [3, 4], GEN: [31, 32], EXO: [7, 8, 21, 22], LEV: [5, 6], NUM: [16, 17, 29, 30], DEU: [12, 13, 22, 23, 28, 29],
  "1SA": [20, 21, 23, 24], "2SA": [18, 19], "1KI": [4, 5, 18, 20, 22], "2KI": [11, 12], "1CH": [5, 6], "2CH": [1, 2, 13, 14],
  NEH: [3, 4, 9, 10], JOB: [40, 41], ECC: [4, 5], SNG: [6, 7], ISA: [8, 9, 63, 64], JER: [8, 9], EZK: [20, 21], DAN: [3, 4, 5, 6],
  HOS: [1, 2, 11, 12, 13, 14], JON: [1, 2], MIC: [4, 5], NAM: [1, 2], ZEC: [1, 2],
};
export function versificationDiffers(book: string, c1: number, c2: number): boolean {
  const d = DIVERGENT[book];
  if (!d) return false;
  if (d === "all") return true;
  for (let c = c1; c <= c2; c++) if (d.includes(c)) return true;
  return false;
}

export interface SefariaText {
  ref: string;
  collectiveTitle: string;
  versionTitle: string;
  license: string;
  versionSource: string | null;
  text: string;
  url: string;
}

function flattenText(t: unknown): string[] {
  if (typeof t === "string") return [t];
  if (Array.isArray(t)) return t.flatMap(flattenText);
  return [];
}

function cleanSefaria(s: string) {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/[֑-״יִ-ﭏ]+/g, "") // Hebrew lemma headers; the English gloss follows
    .replace(/\s+/g, " ")
    .trim();
}

export async function gatherSefaria(r: Range, authors: string[], signal?: AbortSignal): Promise<{ texts: SefariaText[]; skipped?: string; linkCount: number }> {
  const b = bookByUsfm(r.book)!;
  if (!b.sefaria) return { texts: [], linkCount: 0 };
  if (versificationDiffers(r.book, r.c1, r.c2)) return { texts: [], linkCount: 0, skipped: "Hebrew numbering differs here; Jewish commentary was skipped." };
  const verses: [number, number][] = [];
  for (let c = r.c1; c <= r.c2; c++) {
    const from = c === r.c1 ? r.v1 : 1;
    const to = c === r.c2 ? r.v2 : verseCount(r.book, c);
    for (let v = from; v <= to && verses.length < 6; v++) verses.push([c, v]);
  }
  const wanted = new Set(authors.map((a) => a.toLowerCase()));
  const refs = new Map<string, { collectiveTitle: string }>();
  let linkCount = 0;
  for (const [c, v] of verses) {
    const rel = await fetchJson<any>(`https://www.sefaria.org/api/related/${encodeURIComponent(`${b.sefaria}.${c}.${v}`)}`, { cacheDays: 30, signal });
    const links = (rel.links ?? []).filter((l: any) => l.category === "Commentary");
    linkCount += links.length;
    for (const l of links) {
      const ct = l.collectiveTitle?.en ?? "";
      if (!wanted.has(ct.toLowerCase()) || !l.sourceHasEn) continue;
      refs.set(`${l.index_title} ${c}:${v}`, { collectiveTitle: ct });
    }
  }
  const texts: SefariaText[] = [];
  for (const [ref, meta] of [...refs].slice(0, 8)) {
    try {
      const t = await fetchJson<any>(`https://www.sefaria.org/api/v3/texts/${encodeURIComponent(ref)}?version=english&return_format=text_only`, { cacheDays: 30, signal });
      const v = (t.versions ?? []).find((x: any) => x.language === "en") ?? t.versions?.[0];
      if (!v) continue;
      const text = flattenText(v.text).map(cleanSefaria).filter(Boolean).join("\n\n");
      if (!text) continue;
      texts.push({
        ref: t.ref ?? ref,
        collectiveTitle: meta.collectiveTitle,
        versionTitle: v.versionTitle,
        license: v.license ?? "unknown",
        versionSource: v.versionSource ?? null,
        text,
        url: `https://www.sefaria.org/${encodeURIComponent((t.ref ?? ref).replace(/ /g, "_"))}`,
      });
    } catch {
      /* one missing text doesn't fail the stage */
    }
  }
  return { texts, linkCount };
}

export function sefariaRights(license: string): "public_domain" | "cc_by" | "link_only" {
  const l = license.toLowerCase();
  if (l.includes("public domain")) return "public_domain";
  if (l === "cc-by" || l === "cc by" || l === "cc-by 3.0" || l === "cc-by 4.0") return "cc_by";
  return "link_only";
}

// ---------- G3: OpenBible cross-references ----------
let xrefs: Map<string, { to: string; votes: number }[]> | null = null;
// Reverse index: for each verse, the passages whose cross-references point to it.
let backrefs: Map<string, { from: string; votes: number }[]> | null = null;
export function openbibleAvailable() {
  return fs.existsSync(DATASET_PATHS.openbible);
}
function loadXrefs() {
  if (xrefs) return xrefs;
  const zip = unzipSync(new Uint8Array(fs.readFileSync(DATASET_PATHS.openbible)));
  const name = Object.keys(zip).find((n) => n.endsWith(".txt"))!;
  const text = strFromU8(zip[name]);
  xrefs = new Map();
  backrefs = new Map();
  for (const line of text.split("\n").slice(1)) {
    const [from, to, votes] = line.split("\t");
    if (!from || !to) continue;
    const arr = xrefs.get(from) ?? [];
    arr.push({ to, votes: Number(votes) });
    xrefs.set(from, arr);
    // A target range points back from each of its verses; index its first verse.
    const first = to.split("-")[0];
    const back = backrefs.get(first) ?? [];
    back.push({ from, votes: Number(votes) });
    backrefs.set(first, back);
  }
  return xrefs;
}
export function resetXrefs() {
  xrefs = null;
  backrefs = null;
  prominence = null;
}

// How often readers connect a verse to others: openbible.info votes in both directions, summed. The best-known
// verses (John 3:16, James 1:6) score highest, which makes it a fair guide to a word's "major" uses.
let prominence: Map<string, number> | null = null;
export function verseProminence(book: string, c: number, v: number): number {
  if (!openbibleAvailable()) return 0;
  if (!prominence) {
    const map = loadXrefs();
    prominence = new Map();
    const add = (key: string, votes: number) => {
      if (votes > 0) prominence!.set(key, (prominence!.get(key) ?? 0) + votes);
    };
    for (const [from, tos] of map) for (const t of tos) {
      add(from, t.votes);
      add(t.to.split("-")[0], t.votes);
    }
  }
  return prominence.get(toOpenBible(book, c, v)) ?? 0;
}

/**
 * Passages connected to this one, in both directions: where this passage points, and which passages point here.
 * Votes are openbible.info's community ranking; a link found in both directions is counted once at its higher vote.
 */
export function gatherCrossRefs(r: Range, top = 15, minVotes = 2): { range: PassageRange; votes: number; osis: string; direction: "to" | "from" | "both" }[] {
  const map = loadXrefs();
  const merged = new Map<string, { votes: number; direction: "to" | "from" | "both" }>();
  const add = (osis: string, votes: number, direction: "to" | "from") => {
    if (votes < minVotes) return;
    const cur = merged.get(osis);
    if (!cur) merged.set(osis, { votes, direction });
    else merged.set(osis, { votes: Math.max(cur.votes, votes), direction: cur.direction === direction ? direction : "both" });
  };
  for (let c = r.c1; c <= r.c2; c++) {
    const from = c === r.c1 ? r.v1 : 1;
    const to = c === r.c2 ? r.v2 : verseCount(r.book, c);
    for (let v = from; v <= to; v++) {
      const key = toOpenBible(r.book, c, v);
      for (const x of map.get(key) ?? []) add(x.to, x.votes, "to");
      for (const x of backrefs!.get(key) ?? []) add(x.from, x.votes, "from");
    }
  }
  const out: { range: PassageRange; votes: number; osis: string; direction: "to" | "from" | "both" }[] = [];
  for (const [osis, m] of [...merged].sort((a, b) => b[1].votes - a[1].votes)) {
    const range = fromOpenBible(osis);
    if (!range) continue;
    // drop targets inside the study's own range
    if (range.book === r.book && range.c1 >= r.c1 && range.c2 <= r.c2 && (range.v1 ?? 0) >= r.v1 && (range.v2 ?? 0) <= r.v2 && r.c1 === r.c2) continue;
    out.push({ range, votes: m.votes, osis, direction: m.direction });
    if (out.length >= top) break;
  }
  return out;
}

// ---------- G4: Bible Hub verse-page commentaries ----------
export interface BibleHubSection {
  sectionTitle: string;
  text: string;
  url: string;
}

export function htmlToText(html: string): string {
  const withBreaks = html
    .replace(/<\s*(p|br|div|li|h\d)[^>]*>/gi, "\n\n")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "");
  const { document } = parseHTML(`<!doctype html><html><body>${withBreaks}</body></html>`);
  const text = document.body.textContent ?? "";
  return text
    .replace(/[ \t ]+/g, " ")
    .split(/\n\s*\n/)
    .map((p: string) => p.replace(/\s*\n\s*/g, " ").trim())
    .filter(Boolean)
    .join("\n\n");
}

export function splitBibleHub(html: string, url: string): BibleHubSection[] {
  const start = html.indexOf('<div id="leftbox">');
  const body = start >= 0 ? html.slice(start) : html;
  const chunks = body.split(/<div class="vheading2">/).slice(1);
  const out: BibleHubSection[] = [];
  for (const chunk of chunks) {
    const end = chunk.indexOf("</div>");
    const title = htmlToText(chunk.slice(0, end)).trim();
    if (!title || /^links$/i.test(title)) break;
    let rest = chunk.slice(end + 6);
    // stop at the next structural block (category label, footer)
    const stop = rest.search(/<div class="(comtype|vheading|botbox|bottomlink)/);
    if (stop >= 0) rest = rest.slice(0, stop);
    const text = htmlToText(rest);
    if (text.length > 40) out.push({ sectionTitle: title, text, url });
  }
  return out;
}

export async function gatherBibleHub(r: Range, signal?: AbortSignal): Promise<BibleHubSection[]> {
  const out: BibleHubSection[] = [];
  const verses: [number, number][] = [];
  for (let c = r.c1; c <= r.c2 && verses.length < 2; c++) {
    const from = c === r.c1 ? r.v1 : 1;
    const to = c === r.c2 ? r.v2 : verseCount(r.book, c);
    for (let v = from; v <= to && verses.length < 2; v++) verses.push([c, v]);
  }
  for (const [c, v] of verses) {
    const url = toBibleHubVerseUrl(r.book, c, v);
    const page = await fetchText(url, { page: true, cacheDays: 30, signal });
    out.push(...splitBibleHub(page.body, url));
  }
  return out;
}
