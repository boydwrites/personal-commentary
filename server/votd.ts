// Daily references come from Bible.com, then OurManna. All text comes from the local BSB.
// The database is the daily cache; a changing feed must never use the HTTP body cache.
import type { DB } from "./db.ts";
import { localDate, nowIso } from "./db.ts";
import { fetchJson, fetchText } from "./fetcher.ts";
import { parseReference, toUsfm } from "../shared/refs.ts";
import { expandRange } from "./bible.ts";
import { log } from "./log.ts";

export interface Votd {
  ref: string;
  source: "bible.com" | "ourmanna" | "local";
}

// Short, meaningful passages for offline daily reading and browsing. References only: no copied feed text.
export const DISCOVERY_PASSAGES = [
  "GEN.1.1-GEN.1.5", "GEN.12.1-GEN.12.3", "EXO.3.11-EXO.3.12", "EXO.33.14", "DEU.6.4-DEU.6.9",
  "JOS.1.9", "RUT.1.16-RUT.1.17", "1SA.16.7", "1KI.19.11-1KI.19.13", "NEH.8.10",
  "PSA.1.1-PSA.1.3", "PSA.19.1-PSA.19.4", "PSA.23.1-PSA.23.6", "PSA.27.1", "PSA.34.8",
  "PSA.46.1-PSA.46.3", "PSA.51.10", "PSA.90.12", "PSA.103.8-PSA.103.12", "PSA.119.105",
  "PSA.121.1-PSA.121.2", "PSA.139.13-PSA.139.16", "PRO.3.5-PRO.3.6", "PRO.4.23", "PRO.16.9",
  "ECC.3.1-ECC.3.8", "ISA.9.6", "ISA.40.28-ISA.40.31", "ISA.43.1-ISA.43.3", "ISA.55.8-ISA.55.11",
  "LAM.3.22-LAM.3.24", "MIC.6.8", "HAB.3.17-HAB.3.19", "MAT.5.14-MAT.5.16", "MAT.6.25-MAT.6.27",
  "MAT.6.33-MAT.6.34", "MAT.11.28-MAT.11.30", "MAT.22.37-MAT.22.40", "MRK.10.45", "LUK.10.38-LUK.10.42",
  "JHN.1.1-JHN.1.5", "JHN.3.16-JHN.3.17", "JHN.13.34-JHN.13.35", "JHN.15.1-JHN.15.5", "ACT.2.42-ACT.2.47",
  "ROM.5.1-ROM.5.5", "ROM.8.38-ROM.8.39", "ROM.12.1-ROM.12.2", "1CO.13.4-1CO.13.7", "2CO.4.16-2CO.4.18",
  "GAL.5.22-GAL.5.25", "EPH.2.8-EPH.2.10", "PHP.2.3-PHP.2.8", "PHP.4.6-PHP.4.9", "COL.3.12-COL.3.17",
  "1TH.5.16-1TH.5.18", "HEB.12.1-HEB.12.3", "JAS.1.19-JAS.1.22", "1PE.5.6-1PE.5.7", "REV.21.1-REV.21.5",
] as const;

/** UTC arithmetic on the local calendar date avoids DST changing the rotation. */
export function localDailyPassage(date: string, previousRef?: string): string {
  const day = Math.floor(Date.parse(`${date}T12:00:00Z`) / 86_400_000);
  const index = ((day % DISCOVERY_PASSAGES.length) + DISCOVERY_PASSAGES.length) % DISCOVERY_PASSAGES.length;
  const ref = DISCOVERY_PASSAGES[index];
  return ref === previousRef ? DISCOVERY_PASSAGES[(index + 1) % DISCOVERY_PASSAGES.length] : ref;
}

/** Pulls the reference out of bible.com's page: the <title> first, then a USFM link. */
export function parseBibleComVotd(html: string): string | null {
  const title = html.match(/<title>\s*Verse of the Day\s*[-–]\s*(.+?)\s*[-–]\s*Bible App\s*<\/title>/i);
  if (title) return title[1].replace(/&#x27;|&#39;/g, "'").trim();
  const usfm = html.match(/\/bible\/\d+\/([1-3]?[A-Z]{2,3}\.\d+\.\d+(?:-\d+)?)/);
  return usfm ? usfm[1] : null;
}

function canonicalReference(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const parsed = parseReference(value);
  if (!parsed.ok) return null;
  const expanded = expandRange(parsed.range);
  return expanded.ok ? toUsfm(expanded.range) : null;
}

function previousDailyReference(db: DB, date: string): string | undefined {
  const yesterday = new Date(`${date}T12:00:00Z`);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const row = db.prepare("SELECT canonical_ref FROM votd_days WHERE local_date = ?").get(yesterday.toISOString().slice(0, 10)) as { canonical_ref: string } | undefined;
  return row?.canonical_ref;
}

// Multiple tabs opening at once share a single daily fetch.
const pending = new WeakMap<DB, Map<string, Promise<Votd>>>();
export async function getVerseOfTheDay(db: DB, date = localDate()): Promise<Votd> {
  const row = db.prepare("SELECT canonical_ref, source FROM votd_days WHERE local_date = ?").get(date) as { canonical_ref: string; source: Votd["source"] } | undefined;
  // Older installs can already have cached the same feed pick on two local dates.
  // Repair that duplicate once; keep every other cached day stable.
  if (row && row.canonical_ref !== previousDailyReference(db, date)) return { ref: row.canonical_ref, source: row.source };
  let days = pending.get(db);
  if (!days) pending.set(db, days = new Map());
  const existing = days.get(date);
  if (existing) return existing;
  const request = fetchDailyVerse(db, date).finally(() => days.delete(date));
  days.set(date, request);
  return request;
}

async function fetchDailyVerse(db: DB, date: string): Promise<Votd> {
  const previous = previousDailyReference(db, date);
  let ref: string | null = null;
  let source: Votd["source"] = "bible.com";
  try {
    const page = await fetchText("https://www.bible.com/verse-of-the-day", { page: true, retries: 1, timeoutMs: 8_000, cacheDays: 0 });
    ref = canonicalReference(parseBibleComVotd(page.body));
    if (ref === previous) ref = null;
    if (!ref) log("warn", "votd", "bible_com_unparsed_or_repeated", { bytes: page.body.length });
  } catch (e) {
    log("warn", "votd", "bible_com_failed", { error: String(e) });
  }
  if (!ref) {
    try {
      const response = await fetchJson<{ verse?: { details?: { reference?: string } } }>("https://beta.ourmanna.com/api/v1/get?format=json&order=daily", { retries: 1, timeoutMs: 5_000, cacheDays: 0 });
      ref = canonicalReference(response?.verse?.details?.reference);
      if (ref === previous) ref = null;
      source = "ourmanna";
    } catch (e) {
      log("warn", "votd", "ourmanna_failed", { error: String(e) });
    }
  }
  if (!ref) {
    ref = localDailyPassage(date, previous);
    source = "local";
  }
  db.prepare(`INSERT INTO votd_days (local_date, source, passage_id, canonical_ref, fetched_at) VALUES (?,?,?,?,?)
    ON CONFLICT(local_date) DO UPDATE SET source = excluded.source, passage_id = excluded.passage_id,
      canonical_ref = excluded.canonical_ref, fetched_at = excluded.fetched_at
    WHERE votd_days.canonical_ref = ?`).run(date, source, ref, ref, nowIso(), previous ?? null);
  const saved = db.prepare("SELECT canonical_ref, source FROM votd_days WHERE local_date = ?").get(date) as { canonical_ref: string; source: Votd["source"] };
  return { ref: saved.canonical_ref, source: saved.source };
}

/** Browsing is free and read-only: a study is created only after Begin study. */
export function shufflePassage(db: DB, exclude: string[] = [], random = Math.random): { ref: string; source: "library" | "curated" } {
  const saved = db.prepare("SELECT DISTINCT primary_ref FROM studies WHERE status IN ('saved', 'published') ORDER BY updated_at DESC LIMIT 300").all() as { primary_ref: string }[];
  const refs = new Map<string, "library" | "curated">(DISCOVERY_PASSAGES.map((ref) => [ref, "curated"]));
  for (const study of saved) {
    const ref = canonicalReference(study.primary_ref);
    if (ref) refs.set(ref, "library");
  }
  const excluded = new Set(exclude);
  let choices = [...refs.keys()].filter((ref) => !excluded.has(ref));
  // Even if a client has browsed the whole collection, never repeat its current passage.
  if (!choices.length) choices = [...refs.keys()].filter((ref) => ref !== exclude.at(-1));
  const ref = choices[Math.floor(random() * choices.length)];
  return { ref, source: refs.get(ref)! };
}
