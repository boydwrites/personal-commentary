// STEPBible data: the Hebrew and Greek words of every verse, tagged with Strong's numbers,
// and the brief lexicons that define them. CC BY 4.0 — attribute STEPBible.org.
// The raw tab-separated files are downloaded once and indexed into a small SQLite file; lookups never touch the network.
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { DATASET_PATHS } from "../config.ts";
import { bookByUsfm, displayRef } from "../../shared/refs.ts";

const BASE = "https://raw.githubusercontent.com/STEPBible/STEPBible-Data/master";
const T = "Translators%20Amalgamated%20OT%2BNT";
export const STEPBIBLE_FILES = [
  `${BASE}/${T}/TAHOT%20Gen-Deu%20-%20Translators%20Amalgamated%20Hebrew%20OT%20-%20STEPBible.org%20CC%20BY.txt`,
  `${BASE}/${T}/TAHOT%20Jos-Est%20-%20Translators%20Amalgamated%20Hebrew%20OT%20-%20STEPBible.org%20CC%20BY.txt`,
  `${BASE}/${T}/TAHOT%20Job-Sng%20-%20Translators%20Amalgamated%20Hebrew%20OT%20-%20STEPBible.org%20CC%20BY.txt`,
  `${BASE}/${T}/TAHOT%20Isa-Mal%20-%20Translators%20Amalgamated%20Hebrew%20OT%20-%20STEPBible.org%20CC%20BY.txt`,
  `${BASE}/${T}/TAGNT%20Mat-Jhn%20-%20Translators%20Amalgamated%20Greek%20NT%20-%20STEPBible.org%20CC-BY.txt`,
  `${BASE}/${T}/TAGNT%20Act-Rev%20-%20Translators%20Amalgamated%20Greek%20NT%20-%20STEPBible.org%20CC-BY.txt`,
  `${BASE}/Lexicons/TBESH%20-%20Translators%20Brief%20lexicon%20of%20Extended%20Strongs%20for%20Hebrew%20-%20STEPBible.org%20CC%20BY.txt`,
  `${BASE}/Lexicons/TBESG%20-%20Translators%20Brief%20lexicon%20of%20Extended%20Strongs%20for%20Greek%20-%20STEPBible.org%20CC%20BY.txt`,
];

export interface StepWord {
  n: number;
  word: string; // as written in the verse, prefixes joined
  translit: string;
  gloss: string; // the English for this word in this verse
  strong: string; // the main (dStrong) number, e.g. H7186, G0163
  morph: string;
}
export interface LexEntry {
  strong: string;
  lemma: string;
  translit: string;
  pos: string; // "H:N-M", "G:V", …
  gloss: string;
  definition: string; // plain text
}

let db: Database.Database | null = null;
export function stepbibleAvailable() {
  return fs.existsSync(DATASET_PATHS.stepbible);
}
function open() {
  if (!db) db = new Database(DATASET_PATHS.stepbible, { readonly: true, fileMustExist: true });
  return db;
}
export function closeStepbible() {
  db?.close();
  db = null;
}

/** Lexicon HTML → plain text: line breaks kept, references written for people, markup dropped. */
export function lexText(html: string): string {
  return html
    .replace(/<ref='([^']+)'>[^<]*<\/ref>/g, (_m, r: string) => stepRefLabel(r) ?? r)
    .replace(/<br\s*\/?>|<BR\s*\/?>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .replace(/^\s*:\s*/, "")
    .trim();
}

/** "2Co.10.5" → "2 Corinthians 10:5" (null for books outside the 66, such as Tobit). */
export function stepRefLabel(r: string): string | null {
  const m = /^([1-3]?[A-Za-z]{2,3})\.(\d+)\.(\d+)/.exec(r);
  if (!m) return null;
  const b = bookByUsfm(m[1].toUpperCase());
  return b ? displayRef({ book: b.usfm, c1: +m[2], v1: +m[3], c2: +m[2], v2: +m[3] }) : null;
}

// ---------- building the index ----------

const REF = /^([1-3]?[A-Za-z]{2,3})\.(\d+)\.(\d+)(?:\([\d.]+\))?#(\d+)=([A-Za-z]+)/;

/** Builds the index from the downloaded raw files. Replaces any earlier index atomically. */
export function buildStepbibleIndex(rawFiles: string[], dest = DATASET_PATHS.stepbible) {
  const tmp = dest + ".building";
  fs.rmSync(tmp, { force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const out = new Database(tmp);
  out.pragma("journal_mode = OFF");
  out.pragma("synchronous = OFF");
  out.exec(`
    CREATE TABLE words (book TEXT NOT NULL, c INTEGER NOT NULL, v INTEGER NOT NULL, n INTEGER NOT NULL, word TEXT NOT NULL, translit TEXT, gloss TEXT, strong TEXT, morph TEXT);
    CREATE TABLE lexicon (strong TEXT PRIMARY KEY, base TEXT NOT NULL, lemma TEXT, translit TEXT, pos TEXT, gloss TEXT, definition TEXT);
  `);
  const insW = out.prepare("INSERT INTO words (book, c, v, n, word, translit, gloss, strong, morph) VALUES (?,?,?,?,?,?,?,?,?)");
  const insL = out.prepare("INSERT OR IGNORE INTO lexicon (strong, base, lemma, translit, pos, gloss, definition) VALUES (?,?,?,?,?,?,?)");
  let words = 0;
  out.transaction(() => {
    for (const file of rawFiles) {
      // NFC: STEPBible writes Greek accents as oxia; the canonical form (tonos) is what everything else uses.
      const text = fs.readFileSync(file, "utf8").normalize("NFC");
      for (const line of text.split("\n")) {
        const f = line.split("\t");
        if (/^[HG]\d{4}[A-Za-z]?$/.test(f[0] ?? "") && f.length >= 8 && /=/.test(f[1] ?? "")) {
          // A lexicon row: eStrong, "dStrong = …", uStrong, lemma, translit, pos, gloss, definition
          const strong = (f[1] ?? "").split(/\s/)[0];
          if (!/^[HG]\d{4}[A-Za-z]?$/.test(strong)) continue;
          insL.run(strong, f[0], f[3], f[4], f[5], f[6], lexText(f[7] ?? ""));
          continue;
        }
        const m = REF.exec(f[0] ?? "");
        if (!m) continue;
        const book = m[1].toUpperCase();
        if (!bookByUsfm(book)) continue;
        const greek = f[0].includes("=N") || /^G/.test(f[3] ?? "");
        if (greek) {
          // NT: keep the words of the Nestle-Aland text (type contains N), which the BSB follows.
          if (!m[5].includes("N")) continue;
          const wm = /^(.*?)\s*\((.*)\)\s*$/.exec(f[1] ?? "");
          const [strong, morph] = (f[3] ?? "").split("=");
          insW.run(book, +m[2], +m[3], +m[4], wm ? wm[1] : f[1], wm ? wm[2] : "", (f[2] ?? "").trim(), strong.replace(/_.*$/, ""), morph ?? "");
        } else {
          // OT: the main word is the braced Strong's number; prefixes and suffixes are H9xxx.
          const main = /\{(H\d{4}[A-Za-z]?)\}/.exec(f[4] ?? "");
          insW.run(book, +m[2], +m[3], +m[4], (f[1] ?? "").replace(/[/\\]/g, ""), (f[2] ?? "").replace(/[/\\]/g, ""), (f[3] ?? "").replace(/\/\s*/g, " ").trim(), main ? main[1] : "", f[5] ?? "");
        }
        words++;
      }
    }
  })();
  out.exec("CREATE INDEX idx_words_ref ON words(book, c, v, n); CREATE INDEX idx_words_strong ON words(strong);");
  out.close();
  closeStepbible();
  fs.renameSync(tmp, dest);
  return { words };
}

// ---------- lookups ----------

export function wordsFor(book: string, c: number, v: number): StepWord[] {
  return open().prepare("SELECT n, word, translit, gloss, strong, morph FROM words WHERE book = ? AND c = ? AND v = ? ORDER BY n").all(book, c, v) as StepWord[];
}

export function lexicon(strong: string): LexEntry | null {
  const d = open();
  const row = (d.prepare("SELECT * FROM lexicon WHERE strong = ?").get(strong) ??
    d.prepare("SELECT * FROM lexicon WHERE base = ? ORDER BY strong LIMIT 1").get(strong.slice(0, 5))) as any;
  return row ? { strong, lemma: row.lemma, translit: row.translit, pos: row.pos, gloss: row.gloss, definition: row.definition } : null;
}

/** How often a word occurs in the Bible, and where (canonical order; verses de-duplicated). */
export function occurrences(strong: string): { count: number; refs: { book: string; c: number; v: number }[] } {
  const rows = open().prepare("SELECT DISTINCT book, c, v FROM words WHERE strong = ?").all(strong) as { book: string; c: number; v: number }[];
  const idx = (b: string) => bookByUsfm(b)?.index ?? 99;
  rows.sort((a, b) => idx(a.book) - idx(b.book) || a.c - b.c || a.v - b.v);
  const count = (open().prepare("SELECT COUNT(*) n FROM words WHERE strong = ?").get(strong) as any).n as number;
  return { count, refs: rows };
}

/** How many times a word is written in the Bible (its testament, in fact: the Greek covers the New, the Hebrew the Old). */
export function useCount(strong: string): number {
  return (open().prepare("SELECT COUNT(*) n FROM words WHERE strong = ?").get(strong) as any).n as number;
}

/** A bare Strong's number ("G4102") as the tagged text writes it ("G4102G"): the most used of its forms. */
export function resolveStrong(strong: string): string {
  const d = open();
  if (d.prepare("SELECT 1 FROM words WHERE strong = ? LIMIT 1").get(strong) || /[A-Za-z]$/.test(strong)) return strong;
  const row = d.prepare("SELECT strong, COUNT(*) n FROM words WHERE strong GLOB ? GROUP BY strong ORDER BY n DESC LIMIT 1").get(`${strong}[A-Z]`) as any;
  return row?.strong ?? strong;
}

/** Every use of a word, with the form written there and STEPBible's English for it in that verse, in canonical order. */
export function usesOf(strong: string): (StepWord & { book: string; c: number; v: number })[] {
  const rows = open().prepare("SELECT book, c, v, n, word, translit, gloss, strong, morph FROM words WHERE strong = ?").all(strong) as (StepWord & { book: string; c: number; v: number })[];
  const idx = (b: string) => bookByUsfm(b)?.index ?? 99;
  return rows.sort((a, b) => idx(a.book) - idx(b.book) || a.c - b.c || a.v - b.v || a.n - b.n);
}

/** STEPBible marks Hebrew syllables with dots and stress with a capital ("za.Vat"); readers want "zavat". */
export function plainTranslit(t: string): string {
  return /\./.test(t) || /[a-z][A-Z]/.test(t) ? t.replace(/\./g, "").toLowerCase() : t;
}

/** Nouns, verbs, adjectives, and names: the words worth a word study. Particles, articles, and pronouns are skipped. */
export function isContentWord(e: LexEntry | null): boolean {
  return !!e && /^[HG]:(N|V|A)(?!dv)/.test(e.pos ?? "");
}
