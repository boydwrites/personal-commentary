// Normalization and quotation matching. Deterministic, no model calls.

export interface Normalized {
  text: string;
  /** map[i] = index in the original string of normalized character i */
  map: number[];
}

const SINGLE_QUOTES = /[‘’‚‛′]/;
const DOUBLE_QUOTES = /[“”„‟″]/;
const DASHES = /[‒–—―−]/;
const ZERO_WIDTH = /[­​-‍﻿]/;
const HEBREW_POINTS = /[֑-ׇ]/;
const SUPERSCRIPT_DIGITS = /[¹²³⁰-⁹]/;

/** Normalizes text and keeps an offset map back to the original. Footnote markers like [12] are dropped. */
export function normalize(input: string): Normalized {
  const out: string[] = [];
  const map: number[] = [];
  let lastSpace = true;
  const s = input;
  for (let i = 0; i < s.length; i++) {
    let ch = s[i];
    // bracketed numerals: [12]
    if (ch === "[") {
      const m = /^\[\d{1,3}\]/.exec(s.slice(i, i + 5));
      if (m) {
        i += m[0].length - 1;
        continue;
      }
    }
    if (ZERO_WIDTH.test(ch) || HEBREW_POINTS.test(ch) || SUPERSCRIPT_DIGITS.test(ch)) continue;
    if (SINGLE_QUOTES.test(ch)) ch = "'";
    else if (DOUBLE_QUOTES.test(ch)) ch = '"';
    else if (DASHES.test(ch)) ch = "-";
    else if (ch === "…") {
      for (const c of "...") {
        out.push(c);
        map.push(i);
      }
      lastSpace = false;
      continue;
    }
    ch = ch.normalize("NFKC").toLowerCase();
    if (/\s/.test(ch)) {
      if (lastSpace) continue;
      out.push(" ");
      map.push(i);
      lastSpace = true;
      continue;
    }
    for (const c of ch) {
      out.push(c);
      map.push(i);
    }
    lastSpace = false;
  }
  while (out.length && out[out.length - 1] === " ") {
    out.pop();
    map.pop();
  }
  return { text: out.join(""), map };
}

/** Loose form: letters, digits, and single spaces only. Also keeps an offset map. */
export function loose(input: string): Normalized {
  const n = normalize(input);
  const out: string[] = [];
  const map: number[] = [];
  let lastSpace = true;
  for (let i = 0; i < n.text.length; i++) {
    const ch = n.text[i];
    if (/[\p{L}\p{N}]/u.test(ch)) {
      out.push(ch);
      map.push(n.map[i]);
      lastSpace = false;
    } else if (!lastSpace) {
      out.push(" ");
      map.push(n.map[i]);
      lastSpace = true;
    }
  }
  while (out.length && out[out.length - 1] === " ") {
    out.pop();
    map.pop();
  }
  return { text: out.join(""), map };
}

export type MatchLevel = "exact" | "loose" | "elided" | "not_found";

export interface MatchResult {
  level: MatchLevel;
  /** offsets in the ORIGINAL source text */
  start?: number;
  end?: number;
  nearMatch?: string; // the source's actual wording when a near match exists
}

function endOffset(n: Normalized, idx: number, source: string): number {
  // idx = last normalized char index included
  const orig = n.map[idx];
  // extend to cover a full surrogate pair or combined char
  let e = orig + 1;
  while (e < source.length && /[̀-ͯ\uDC00-\uDFFF]/.test(source[e])) e++;
  return e;
}

/** Checks a quotation against a source text (§16.2). Near matches are reported but never accepted. */
export function matchQuotation(quote: string, source: string): MatchResult {
  const q = normalize(stripOuterQuotes(quote));
  if (q.text.length < 2) return { level: "not_found" };
  const s = normalize(source);
  let i = s.text.indexOf(q.text);
  if (i >= 0) return { level: "exact", start: s.map[i], end: endOffset(s, i + q.text.length - 1, source) };

  const ql = loose(stripOuterQuotes(quote));
  const sl = loose(source);
  if (ql.text.length >= 2) {
    i = sl.text.indexOf(ql.text);
    if (i >= 0) return { level: "loose", start: sl.map[i], end: endOffset(sl, i + ql.text.length - 1, source) };
  }

  if (q.text.includes("...")) {
    const segments = q.text.split("...").map((x) => loose(x).text).filter((x) => x.split(" ").filter(Boolean).length >= 3);
    if (segments.length >= 1 && segments.length === q.text.split("...").filter((x) => loose(x).text.length > 0).length) {
      let from = 0;
      let first = -1;
      let lastEnd = -1;
      let ok = true;
      for (const seg of segments) {
        const at = sl.text.indexOf(seg, from);
        if (at < 0) {
          ok = false;
          break;
        }
        if (first < 0) first = at;
        lastEnd = at + seg.length;
        from = lastEnd;
      }
      if (ok && lastEnd - first <= 600) {
        return { level: "elided", start: sl.map[first], end: endOffset(sl, lastEnd - 1, source) };
      }
    }
  }

  const near = findNearMatch(ql.text, sl);
  return near ? { level: "not_found", nearMatch: source.slice(near.start, near.end) } : { level: "not_found" };
}

/** Sliding-window near match: Levenshtein distance within 3% of the quotation's length. */
function findNearMatch(q: string, s: Normalized): { start: number; end: number } | null {
  if (q.length < 12 || q.length > 600 || s.text.length > 400_000) return null;
  const budget = Math.max(1, Math.floor(q.length * 0.03));
  const firstWord = q.split(" ")[0];
  const lastWord = q.split(" ").at(-1)!;
  let from = 0;
  while (true) {
    const at = s.text.indexOf(firstWord, from);
    if (at < 0) break;
    for (const len of [q.length - budget, q.length, q.length + budget]) {
      const cand = s.text.slice(at, at + len + 1);
      const end = cand.lastIndexOf(lastWord);
      if (end < 0) continue;
      const window = cand.slice(0, end + lastWord.length);
      if (distanceWithin(q, window, budget)) {
        return { start: s.map[at], end: s.map[at + window.length - 1] + 1 };
      }
    }
    from = at + 1;
  }
  return null;
}

function distanceWithin(a: string, b: string, k: number): boolean {
  if (Math.abs(a.length - b.length) > k) return false;
  let prev = new Array(b.length + 1).fill(0).map((_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > k) return false;
    prev = cur;
  }
  return prev[b.length] <= k;
}

export function stripOuterQuotes(s: string): string {
  return s.trim().replace(/^["“”'‘’]+|["“”'‘’]+$/g, "").trim();
}

/** Double-quoted spans in text: straight or curly. Returns inner text and offsets of the whole quoted span. */
export function findQuotations(text: string): { inner: string; start: number; end: number; innerStart: number }[] {
  const out: { inner: string; start: number; end: number; innerStart: number }[] = [];
  const re = /(["“])([^"“”\n]*)(["”])/g;
  for (const m of text.matchAll(re)) {
    out.push({ inner: m[2], start: m.index!, end: m.index! + m[0].length, innerStart: m.index! + 1 });
  }
  return out;
}

export function words(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[’']/g, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

export function wordCount(s: string): number {
  return (s.match(/[\p{L}\p{N}’'-]+/gu) ?? []).length;
}

/** Lines starting with ">" in a note are words the user kept from the passage or the research, not their own (R1). */
export const isKeptLine = (line: string) => /^\s*>/.test(line);

/** The user's own words in a note: everything except the lines they kept from Scripture or the research. */
export function ownWordCount(s: string): number {
  return wordCount(s.split("\n").filter((l) => !isKeptLine(l)).join("\n"));
}

export function trigrams(s: string): Set<string> {
  const w = words(s);
  const out = new Set<string>();
  for (let i = 0; i + 2 < w.length; i++) out.add(`${w[i]} ${w[i + 1]} ${w[i + 2]}`);
  if (w.length > 0 && w.length < 3) out.add(w.join(" "));
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Replaces one quoted span's quotation marks with nothing ("de-quote, don't delete"). */
export function dequoteSpan(body: string, quoteInner: string): string {
  const qs = findQuotations(body);
  const target = normalize(quoteInner).text;
  for (const q of qs) {
    if (normalize(q.inner).text === target) {
      return body.slice(0, q.start) + q.inner + body.slice(q.end);
    }
  }
  return body;
}

/** The normalized form hashed for publish gating (§18.4). Hashing itself happens on the server. */
export function gatingForm(parts: string[], sourceReply: string): string {
  const joined = parts.map((p) => p.trim()).join("\n\n---\n\n") + "\n\n===\n\n" + (sourceReply ?? "").trim();
  return joined
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .join("\n")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/ {2,}/g, " ")
    .trim();
}
