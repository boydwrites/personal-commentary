// One-time repairs of things the app itself wrote wrong. Each runs once, is recorded in preferences, and changes
// only what it can prove: your words are never touched, and the note history keeps the earlier text.
import type { DB } from "./db.ts";
import { nowIso, uuidv7 } from "./db.ts";
import { getChapter } from "./bible.ts";
import { getPrefs, setPrefs } from "./prefs.ts";
import { refreshRecord } from "./records.ts";
import { log } from "./log.ts";
import { bookByName, displayRef, fromUsfm } from "../shared/refs.ts";

const KEPT_CITES = "kept-verse-citations@1";

const words = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/**
 * Before October 7, 2026, a line highlighted anywhere in a passage (the whole chapter included) was cited with the
 * study's reference: Peter's protest (Matthew 16:22) came out as "Matthew 16:24 (BSB)". This re-cites each such line
 * by the verses its words actually come from, when they're found in the cited chapter. Returns the lines changed.
 */
export async function repairKeptCitations(db: DB): Promise<number> {
  const studies = db.prepare("SELECT id, primary_ref, translation_id, note FROM studies WHERE note LIKE '%>%'").all() as any[];
  let fixed = 0;
  for (const s of studies) {
    const range = fromUsfm(s.primary_ref);
    if (!range) continue;
    const chapters = new Map<number, { n: number; text: string }[]>();
    const versesOf = async (c: number) => {
      if (!chapters.has(c)) chapters.set(c, await getChapter({ id: s.translation_id }, range.book, c).then((ch) => ch.verses.map((v: any) => ({ n: v.n, text: words(v.text) })), () => []));
      return chapters.get(c)!;
    };
    let changed = false;
    const lines: string[] = [];
    for (const line of String(s.note).split("\n")) {
      const m = line.match(/^(\s*>\s?)(.*\S)(\s+[—–]\s+)(.+?)\s+(\d+):(\d+)(?:[–-](\d+))?\s+\(([A-Za-z]+)\)\s*$/);
      const quote = m ? words(m[2]) : "";
      if (!m || bookByName(m[4])?.usfm !== range.book || m[8] !== s.translation_id || quote.length < 12) {
        lines.push(line);
        continue;
      }
      // The smallest run of verses in that chapter that holds every word of the line, in order.
      const c = Number(m[5]);
      const verses = await versesOf(c);
      let found: { v1: number; v2: number } | null = null;
      for (let size = 1; size <= 4 && !found; size++)
        for (let i = 0; i + size <= verses.length && !found; i++)
          if (` ${verses.slice(i, i + size).map((v) => v.text).join(" ")} `.includes(` ${quote} `)) found = { v1: verses[i].n, v2: verses[i + size - 1].n };
      const cited = { v1: Number(m[6]), v2: Number(m[7] ?? m[6]) };
      if (!found || (found.v1 === cited.v1 && found.v2 === cited.v2)) {
        lines.push(line);
        continue;
      }
      lines.push(`${m[1]}${m[2]}${m[3]}${displayRef({ book: range.book, c1: c, v1: found.v1, c2: c, v2: found.v2 })} (${m[8]})`);
      changed = true;
      fixed++;
    }
    if (!changed) continue;
    const note = lines.join("\n");
    db.transaction(() => {
      db.prepare("UPDATE studies SET note = ?, note_updated_at = ? WHERE id = ?").run(note, nowIso(), s.id);
      db.prepare("INSERT INTO note_revisions (id, study_id, note, created_at) VALUES (?,?,?,?)").run(uuidv7(), s.id, note, nowIso());
    })();
    refreshRecord(db, s.id);
  }
  return fixed;
}

/** Runs each repair that hasn't run yet on this database. */
export async function runRepairs(db: DB) {
  const done = new Set(getPrefs(db).repairs);
  if (done.has(KEPT_CITES)) return;
  try {
    const fixed = await repairKeptCitations(db);
    setPrefs(db, { repairs: [...done, KEPT_CITES] });
    log("info", "repair", "kept_citations", { fixed });
  } catch (e) {
    log("warn", "repair", "kept_citations_failed", { error: String(e) });
  }
}
