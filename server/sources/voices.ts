// Preachers and popular commentaries, gathered deterministically (no model calls here):
// Bible Hub chapter commentaries (Wesley, Matthew Henry, Clarke) and Enduring Word (David Guzik).
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { fetchText } from "../fetcher.ts";
import { BOOKS, bookByUsfm } from "../../shared/refs.ts";
import { htmlToText } from "./gatherers.ts";

type Range = { book: string; c1: number; v1: number; c2: number; v2: number };

export interface VoiceText {
  text: string;
  url: string;
  /** What the text is attached to, e.g. "John 3:16" or "John 3:14–17". */
  locator: string;
  title: string;
}

const decode = (s: string) => htmlToText(s).replace(/\s+/g, " ").trim();

function versesIn(r: Range, c: number): [number, number] | null {
  if (c < r.c1 || c > r.c2) return null;
  return [c === r.c1 ? r.v1 : 1, c === r.c2 ? r.v2 : 999];
}

// ---------- Bible Hub chapter commentaries ----------
/**
 * One page per chapter, one block per verse. Section commentaries (Matthew Henry's Complete) put the whole
 * section's comment on its first verse and leave the rest empty, so an empty verse borrows the nearest earlier comment.
 */
export function parseBibleHubChapter(html: string, c: number, from: number, to: number): { v: number; text: string; startVerse: number; endVerse: number }[] {
  // Split on verse markers; whatever follows a verse's text (inside a "comm" div or bare, as Clarke's is) is its comment.
  const marks = [...html.matchAll(/<div class="versenum"><a href="[^"]*?(\d+)-(\d+)\.htm">/g)];
  const blocks = marks.map((m, i) => {
    let chunk = html.slice(m.index! + m[0].length, marks[i + 1]?.index ?? undefined);
    const stop = chunk.search(/<div (?:id="(?:botbox|bottom)|class="(?:botbox|bottomlink|padbot|vheading))/);
    if (stop >= 0) chunk = chunk.slice(0, stop);
    chunk = chunk.replace(/^[\s\S]*?<\/a><\/div>/, "").replace(/<div class="verse">[\s\S]*?<\/div>/, "");
    return { c: Number(m[1]), v: Number(m[2]), text: decode(chunk) };
  }).filter((b) => b.c === c);
  const out: { v: number; text: string; startVerse: number; endVerse: number }[] = [];
  const seen = new Set<string>();
  for (const b of blocks) {
    if (b.v < from || b.v > to) continue;
    let k = blocks.indexOf(b);
    while (k > 0 && b.v - blocks[k].v < 25 && !blocks[k].text) k--;
    const src = blocks[k];
    if (!src.text || seen.has(src.text)) continue;
    seen.add(src.text);
    // A section comment runs until the next verse with its own comment.
    let e = k + 1;
    while (e < blocks.length && !blocks[e].text) e++;
    out.push({ v: b.v, text: src.text, startVerse: src.v, endVerse: blocks[e - 1].v });
  }
  return out;
}

const CHAPTER_WORKS: Record<string, string> = { wes: "Explanatory Notes", mhc: "Commentary on the Whole Bible", clarke: "Commentary on the Bible" };

export async function gatherBibleHubChapter(r: Range, slug: string, signal?: AbortSignal): Promise<VoiceText[]> {
  const b = bookByUsfm(r.book)!;
  const out: VoiceText[] = [];
  for (let c = r.c1; c <= r.c2 && c <= r.c1 + 1; c++) {
    const span = versesIn(r, c)!;
    const url = `https://biblehub.com/commentaries/${slug}/${b.biblehub}/${c}.htm`;
    let page;
    try {
      page = await fetchText(url, { page: true, cacheDays: 30, signal });
    } catch {
      continue; // this commentary doesn't cover the book
    }
    for (const x of parseBibleHubChapter(page.body, c, span[0], span[1])) {
      out.push({ text: x.text, url, locator: `${b.name} ${c}:${x.startVerse}${x.endVerse > x.startVerse ? `–${x.endVerse}` : ""}`, title: CHAPTER_WORKS[slug] ?? "Commentary" });
    }
  }
  return out;
}

// ---------- Enduring Word (David Guzik) ----------
export function enduringWordUrl(book: string, c: number): string {
  const b = bookByUsfm(book)!;
  const slug = b.usfm === "PSA" ? "psalm" : b.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return `https://enduringword.com/bible-commentary/${slug}-${c}/`;
}

/** Sections are headed `<h4 id="section-N">N. (14-15) Title</h4>`; keep those that overlap the verses. */
export function parseEnduringWord(html: string, from: number, to: number): { range: [number, number]; heading: string; text: string }[] {
  const heads = [...html.matchAll(/<h4 id="section-\d+">([\s\S]*?)<\/h4>/g)];
  const out: { range: [number, number]; heading: string; text: string }[] = [];
  heads.forEach((h, i) => {
    const heading = decode(h[1]);
    const m = heading.match(/\((\d+)(?:\s*[-–]\s*(\d+))?\)/);
    if (!m) return;
    const range: [number, number] = [Number(m[1]), Number(m[2] ?? m[1])];
    if (range[1] < from || range[0] > to) return;
    const end = heads[i + 1]?.index ?? html.indexOf('class="ew-xref-title"', h.index!);
    const body = html.slice(h.index! + h[0].length, end > 0 ? end : undefined).replace(/<p class="ew-bible-text"[\s\S]*?<\/p>/g, "");
    const text = htmlToText(body).trim();
    if (text.length > 80) out.push({ range, heading: heading.replace(/^\d+\.\s*/, ""), text });
  });
  return out;
}

export async function gatherEnduringWord(r: Range, signal?: AbortSignal): Promise<VoiceText[]> {
  const b = bookByUsfm(r.book)!;
  const out: VoiceText[] = [];
  for (let c = r.c1; c <= r.c2 && c <= r.c1 + 1; c++) {
    const span = versesIn(r, c)!;
    const url = enduringWordUrl(r.book, c);
    let page;
    try {
      page = await fetchText(url, { page: true, cacheDays: 30, signal });
    } catch {
      continue;
    }
    for (const s of parseEnduringWord(page.body, span[0], span[1]).slice(0, 2)) {
      const loc = s.range[0] === s.range[1] ? `${b.name} ${c}:${s.range[0]}` : `${b.name} ${c}:${s.range[0]}–${s.range[1]}`;
      out.push({ text: s.text, url, locator: loc, title: "Enduring Word" });
    }
  }
  return out;
}

// ---------- Whether a page actually speaks to the passage ----------
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** True when the text cites a verse of the range ("John 3:16", "Jn. 3:14-17", "John 3:16–18"). */
export function mentionsPassage(text: string, r: Range): boolean {
  const b = bookByUsfm(r.book)!;
  const names = [...new Set([b.name, ...b.aliases.filter((a) => a.length > 1)])].sort((x, y) => y.length - x.length).map((n) => esc(n).replace(/\s+/g, "\\s*"));
  // "1 John 3:16" is not John 3:16: no book number or ordinal may precede the name.
  const re = new RegExp(`(?:^|[^A-Za-z0-9])(?<!(?:[123]|I{1,3}|1st|2nd|3rd|first|second|third)\\s*)(?:${names.join("|")})\\.?\\s*(\\d+)\\s*[:.]\\s*(\\d+)(?:\\s*[-–]\\s*(\\d+))?`, "gi");
  for (const m of text.matchAll(re)) {
    const c = Number(m[1]);
    const v1 = Number(m[2]);
    const v2 = Number(m[3] ?? m[2]);
    const span = versesIn(r, c);
    if (span && v1 <= span[1] && v2 >= span[0]) return true;
  }
  return false;
}

/** Readable article text from a web page (sermon text, column, devotion). */
export function articleText(html: string): { title: string; text: string } {
  const { document } = parseHTML(html);
  const art = new Readability(document as any).parse();
  const text = htmlToText(art?.content ?? "") || (art?.textContent ?? "").trim();
  return { title: (art?.title ?? "").trim(), text };
}

export { BOOKS };
