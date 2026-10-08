// Bible text. The Berean Standard Bible (public domain) is read from a local dataset, so it works offline and needs no key.
// Other translations (NIV, ESV) need a licensed text source before they can be added.
import fs from "node:fs";
import { DATASET_PATHS } from "./config.ts";
import { bookByUsfm, ordinal, type PassageRange, toUsfm } from "../shared/refs.ts";

export interface Verse {
  id: string; // "EXO.33.3"
  book: string;
  chapter: number;
  n: number;
  text: string;
}
export interface ChapterText {
  book: string;
  chapter: number;
  verses: Verse[];
  headings: { beforeVerse: number; text: string }[];
}

// ---- local BSB ----
type BsbBook = { id: string; chapters: { numberOfVerses: number; chapter: { number: number; content: any[] } }[] };
let bsb: Map<string, BsbBook> | null = null;

export function bsbAvailable() {
  return fs.existsSync(DATASET_PATHS.bsb);
}

function loadBsb(): Map<string, BsbBook> {
  if (bsb) return bsb;
  if (!bsbAvailable()) throw new Error("The Berean Standard Bible hasn't been downloaded yet. Open Settings → Data to download it.");
  const data = JSON.parse(fs.readFileSync(DATASET_PATHS.bsb, "utf8"));
  bsb = new Map((data.books as BsbBook[]).map((b) => [b.id, b]));
  return bsb;
}
export function resetBsbCache() {
  bsb = null;
}

function verseContentText(content: any[]): string {
  const parts: string[] = [];
  for (const c of content) {
    if (typeof c === "string") parts.push(c);
    else if (c && typeof c.text === "string") parts.push(c.text);
    else if (c && c.lineBreak) parts.push(" ");
    // footnote markers ({noteId}) are dropped
  }
  return parts.join(" ").replace(/\s+/g, " ").replace(/\s+([,.;:!?’”])/g, "$1").trim();
}

function bsbChapter(book: string, chapter: number): ChapterText {
  const b = loadBsb().get(book);
  const ch = b?.chapters[chapter - 1];
  if (!ch) throw new Error(`${bookByUsfm(book)?.name ?? book} has no chapter ${chapter}.`);
  const verses: Verse[] = [];
  const headings: ChapterText["headings"] = [];
  let pendingHeading: string | null = null;
  for (const item of ch.chapter.content) {
    if (item.type === "heading") pendingHeading = (item.content ?? []).join(" ");
    else if (item.type === "verse") {
      if (pendingHeading) {
        headings.push({ beforeVerse: item.number, text: pendingHeading });
        pendingHeading = null;
      }
      verses.push({ id: `${book}.${chapter}.${item.number}`, book, chapter, n: item.number, text: verseContentText(item.content) });
    }
  }
  return { book, chapter, verses, headings };
}

/** Chapter and verse counts (English versification, from the local BSB). */
export function chapterCount(book: string): number {
  return loadBsb().get(book)?.chapters.length ?? 0;
}
export function verseCount(book: string, chapter: number): number {
  return loadBsb().get(book)?.chapters[chapter - 1]?.numberOfVerses ?? 0;
}

export interface TranslationRef {
  id: string; // abbreviation; only "BSB" is available today
}

export async function getChapter(t: TranslationRef, book: string, chapter: number): Promise<ChapterText> {
  if (t.id !== "BSB") throw new Error(`Only the Berean Standard Bible is available right now (this study uses ${t.id}).`);
  return bsbChapter(book, chapter);
}

/** Fills in whole-chapter ranges and validates bounds. */
export function expandRange(r: PassageRange): { ok: true; range: Required<PassageRange> & { v1: number; v2: number } } | { ok: false; error: string; suggestion?: string } {
  const b = bookByUsfm(r.book)!;
  const chapters = chapterCount(r.book);
  if (r.c1 > chapters || r.c2 > chapters) {
    return { ok: false, error: `${b.name} has ${chapters} chapters.`, suggestion: `${b.name} ${Math.min(r.c1, chapters)}` };
  }
  const v1 = r.v1 ?? 1;
  const v2 = r.v2 ?? verseCount(r.book, r.c2);
  const max1 = verseCount(r.book, r.c1);
  const max2 = verseCount(r.book, r.c2);
  if (v1 > max1) return { ok: false, error: `${b.name} ${r.c1} has ${max1} verses.`, suggestion: `${b.name} ${r.c1}:${max1}` };
  if (v2 > max2) return { ok: false, error: `${b.name} ${r.c2} has ${max2} verses.`, suggestion: `${b.name} ${r.c2}:${max2}` };
  return { ok: true, range: { book: r.book, c1: r.c1, v1, c2: r.c2, v2 } };
}

export function rangeOrds(r: { book: string; c1: number; v1: number; c2: number; v2: number }) {
  return { start: ordinal(r.book, r.c1, r.v1), end: ordinal(r.book, r.c2, r.v2) };
}

export function verseCountInRange(r: { book: string; c1: number; v1: number; c2: number; v2: number }): number {
  let n = 0;
  for (let c = r.c1; c <= r.c2; c++) {
    const from = c === r.c1 ? r.v1 : 1;
    const to = c === r.c2 ? r.v2 : verseCount(r.book, c);
    n += Math.max(0, to - from + 1);
  }
  return n;
}

/** Verses of a range in a translation. */
export async function getPassage(t: TranslationRef, r: { book: string; c1: number; v1: number; c2: number; v2: number }): Promise<Verse[]> {
  const out: Verse[] = [];
  for (let c = r.c1; c <= r.c2; c++) {
    const ch = await getChapter(t, r.book, c);
    for (const v of ch.verses) {
      if (c === r.c1 && v.n < r.v1) continue;
      if (c === r.c2 && v.n > r.v2) continue;
      out.push(v);
    }
  }
  return out;
}

export function versesToText(vs: Verse[], withNumbers = true): string {
  let lastChapter = -1;
  return vs
    .map((v) => {
      const label = withNumbers ? (v.chapter !== lastChapter && vs.some((x) => x.chapter !== vs[0].chapter) ? `[${v.chapter}:${v.n}] ` : `[${v.n}] `) : "";
      lastChapter = v.chapter;
      return label + v.text;
    })
    .join(" ");
}

export { toUsfm };
