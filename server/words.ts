// Word studies: one Hebrew or Greek word made readable — what it means, how English renders it across the Bible,
// and the best-known verses that use it. Everything here is local data (STEPBible, the BSB, OpenBible votes); no model calls.
import { getPassage } from "./bible.ts";
import { lexicon, resolveStrong, usesOf, useCount, wordsFor, isContentWord, plainTranslit, type LexEntry } from "./sources/stepbible.ts";
import { verseProminence } from "./sources/gatherers.ts";
import { bookByUsfm, displayRef, findReferencesInText, type PassageRange } from "../shared/refs.ts";

export interface Sense { depth: number; label: string | null; text: string; refs: string[]; heading?: boolean }
export interface Rendering { label: string; count: number }
export interface KeyUse { ref: string; usfm: string; text: string; rendering: string; mark: [number, number] | null; sameBook: boolean }

type Range = { book: string; c1: number; v1: number; c2: number; v2: number };
const inRange = (r: Range | null, book: string, c: number, v: number) =>
  !!r && book === r.book && (c > r.c1 || (c === r.c1 && v >= r.v1)) && (c < r.c2 || (c === r.c2 && v <= r.v2));
const verseRef = (book: string, c: number, v: number) => displayRef({ book, c1: c, v1: v, c2: c, v2: v });

// ---------- How English renders the word ----------

// Small words that don't carry the word's meaning: "shall doubt", "[the] welfare of", "He made distinction".
const FILLER = new Set(
  ("a an the to of in on for and or but with by from at as into upon unto is are was were be been being am shall will would should may might must can could " +
    "do does did has have had having he she it they we you i him her them us me my your his its our their thy thine this that these those who whom which what " +
    "not no let made make makes making o one ones there here so then when own like according about even also very").split(" "),
);
const cleanGloss = (g: string) => g.toLowerCase().replace(/\[[^\]]*\]|<[^>]*>|¿/g, " ").replace(/[^a-z'\s-]/g, " ").replace(/\s+/g, " ").trim();
export const stem = (w: string) => w.replace(/'s$/, "").replace(/(ings?|ed|es|s|ly)$/, "").replace(/(.)\1$/, "$1").replace(/e$/, "");
function contentOf(gloss: string): string[] {
  const words = cleanGloss(gloss).split(" ").filter(Boolean);
  const content = words.filter((w) => !FILLER.has(w));
  return content.length ? content : words;
}

/** The English words a gloss uses for the word itself, grouped across forms: "doubting", "shall doubt", "may doubt" → doubt. */
export function renderingsOf(glosses: string[], limit = 6): Rendering[] {
  const groups = new Map<string, { labels: Map<string, number>; count: number }>();
  for (const g of glosses) {
    const content = contentOf(g);
    if (!content.length) continue;
    const key = content.map(stem).join(" ");
    const label = content.join(" ");
    const cur = groups.get(key) ?? { labels: new Map(), count: 0 };
    cur.count++;
    cur.labels.set(label, (cur.labels.get(label) ?? 0) + 1);
    groups.set(key, cur);
  }
  return [...groups.values()]
    .map((x) => ({ label: [...x.labels.keys()].sort((a, b) => a.length - b.length)[0], count: x.count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .slice(0, limit);
}

/** Where the rendering sits in the BSB verse, so the reader can see the word (null when the BSB words it differently). */
export function markRendering(text: string, gloss: string): [number, number] | null {
  const stems = contentOf(gloss).map(stem).filter((s) => s.length >= 3);
  if (!stems.length) return null;
  for (const m of text.matchAll(/[A-Za-z][A-Za-z’']*/g)) {
    const s = stem(m[0].toLowerCase().replace(/’/g, "'"));
    if (stems.some((g) => s === g || (g.length >= 5 && s.startsWith(g)))) return [m.index!, m.index! + m[0].length];
  }
  return null;
}

/** STEPBible's English for one use, without its editorial marks: "with <the> peace" → "with the peace". */
export function tidyGloss(g: string): string {
  const words = g.replace(/[<>\[\]¿]/g, "").replace(/[,.;:·?!]+\s*$/, "").replace(/\s+([,.;:!?])/g, "$1").replace(/\s+/g, " ").trim().split(" ");
  // Hebrew puts the possessive after its noun ("heart your", "in heart my"); English puts it before.
  if (words.length >= 2 && /^(my|your|his|her|its|our|their)$/i.test(words.at(-1)!)) words.splice(words.length - 2, 0, words.pop()!);
  return words.join(" ");
}

// ---------- What the word means ----------

const GREEK = /[\u0370-\u03FF\u1F00-\u1FFF]/;
const HEBREW = /[\u0590-\u05FF]/;

/** The lexicon's senses as readable lines, each with the references the lexicon gives for it. */
export function parseSenses(definition: string, language: "grc" | "he"): Sense[] {
  const out: Sense[] = [];
  const lines = definition.split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].replace(/\(AS\)\s*$/, "").replace(/†/g, "").trim();
    if (!raw || /^\[in LXX/i.test(raw)) continue;
    if (/^SYN\.?:/.test(raw)) break; // synonym essays and their sources
    if (/^[IVX]+\.?$/.test(raw)) continue; // part numbers of a long entry
    if (language === "he") {
      const m = /^(\d+)([a-z]?)(\d*)\)\s*(.*)$/.exec(raw);
      if (m) out.push({ depth: m[3] ? 2 : m[2] ? 1 : 0, label: `${m[1]}${m[2]}${m[3]}`, text: m[4], refs: [] });
      // The entry often opens with the bare gloss ("peace") before its numbered senses; the gloss is shown already.
      else if (!HEBREW.test(raw) && !(out.length === 0 && /^\d+\)/.test(lines[i + 1] ?? "") && raw.split(/\s+/).length <= 3)) out.push({ depth: 0, label: null, text: raw, refs: [] });
      continue;
    }
    // Greek (Abbott-Smith): "__1. to separate, hence, to distinguish: μηδὲν δ., Acts 11:12 …", "__(a) to one another, John 13:35".
    // A line can also turn to the passive or middle partway: "… Jude.22. Pass., to have pity or mercy shown one: …"
    for (const seg of raw.split(/(?<=[.;])\s+(?=(?:Pass|Mid)\.,?\s)/)) greekSense(seg, i === 0 && out.length === 0, out);
  }
  return out.slice(0, 14);
}

function greekSense(seg: string, first: boolean, out: Sense[]) {
  let raw = seg.trim();
  let depth = 0;
  let label: string | null = null;
  let prefix = "";
  const m = /^__\s*(\d+\.|\([a-z]+\))\s*(.*)$/.exec(raw);
  if (m) {
    label = m[1].replace(/\.$/, "");
    depth = /^\d/.test(m[1]) ? 0 : 1;
    raw = m[2];
  } else if (raw.startsWith("__")) {
    raw = raw.replace(/^_+\s*/, "");
    if (/^[IVX]+\.?$/.test(raw)) return; // part numbers of a long entry
  } else {
    const voice = /^(Pass|Mid)\.,?\s*/.exec(raw);
    if (voice) {
      prefix = voice[1] === "Pass" ? "(passive) " : "(middle) ";
      raw = raw.slice(voice[0].length);
    } else if (first && GREEK.test(raw) && raw.length < 40) return; // the headword line: "δια-κρίνω", "ἀγάπη, -ης, ἡ"
    // Unnumbered lines that don't open in English are forms and etymology: "(αἰχμάλωτος), [in LXX …] in late writers = …"
    else if (!/^[A-Za-z]/.test(raw) || /^(in LXX|in late|Outside of|In NT|Cf\.|See)\b/i.test(raw)) return;
  }
  // "… 1 Corinthians 14:29. Mid, and pass.;" — what follows is the middle and passive.
  const voice = /\s*\b(Mid[.,]?\s*(?:,|and)?\s*(?:and\s*)?pass\.?|Pass\.|Mid\.)\s*[;:,.]?\s*$/.exec(raw);
  if (voice && voice.index > 0) raw = raw.slice(0, voice.index);
  raw = raw.replace(/\[[^\]]*\]/g, "");
  const found = findReferencesInText(raw);
  const refs = found.map((r) => r.text.replace(/\s+/g, " "));
  let text: string;
  const colon = raw.indexOf(":");
  if (colon > 0 && !/\d$/.test(raw.slice(0, colon))) text = raw.slice(0, colon);
  else {
    const firstGreek = raw.search(GREEK);
    text = raw.slice(0, Math.min(found[0]?.start ?? raw.length, firstGreek >= 0 ? firstGreek : raw.length));
  }
  // Citations of scholarship ("(ICC, in l.)", "(NT and Eccl., but not LXX)") and leftover abbreviations.
  text = text.replace(/\([^)]*\)/g, "").replace(/\s+([,;.])/g, "$1").replace(/[\s,;:.]+$/, "").replace(/^[\s,;:.]+/, "").replace(/\s{2,}/g, " ");
  if (!m && /\.\s/.test(text)) text = text.split(/\.\s/)[0]; // an unnumbered entry: its first sentence
  text = text.replace(/^Hellenistic,?\s*/, "").replace(/^In pl\.,?\s*/, "(plural) ").replace(/^(absol|metaph)\.,?\s*/i, "");
  if (text) out.push({ depth, label, text: prefix + text, refs });
  else if (refs.length && out.length) out[out.length - 1].refs.push(...refs);
  if (voice && voice.index > 0) out.push({ depth: 0, label: null, text: "Of oneself (its middle and passive forms)", refs: [], heading: true });
}

/** "G:V" → verb, "H:N-M" → noun (masculine), "N:N--L" → a name. */
export function partOfSpeech(pos: string): string {
  if (/^N:/.test(pos)) return "name";
  const m = /^[HG]:([A-Za-z]+)(?:-([MFN]))?/.exec(pos ?? "");
  if (!m) return "";
  const kind = m[1].startsWith("V") ? "verb" : m[1].startsWith("Adv") ? "adverb" : m[1].startsWith("A") ? "adjective" : m[1].startsWith("N") ? "noun" : "";
  const gender = { M: "masculine", F: "feminine", N: "neuter" }[m[2] ?? ""];
  return kind && gender ? `${kind} (${gender})` : kind;
}

// ---------- Where else it's used ----------

/**
 * The major uses of a word outside the passage. A verse's weight is how often readers connect it to others
 * (OpenBible votes), with a lift for the passage's own book and for verses where the BSB's English shows the word.
 * The best verse for each common rendering comes first, so the range of meaning shows; then the best of the rest,
 * at most two per book, in canonical order.
 */
export async function keyUses(strong: string, exclude: Range | null, limit = 6): Promise<{ key: KeyUse[]; total: number }> {
  const seen = new Set<string>();
  type Cand = { book: string; c: number; v: number; gloss: string; score: number; text?: string; mark?: [number, number] | null };
  const verses: Cand[] = [];
  for (const u of usesOf(strong)) {
    const k = `${u.book}.${u.c}.${u.v}`;
    if (seen.has(k) || inRange(exclude, u.book, u.c, u.v)) continue;
    seen.add(k);
    const sameBook = !!exclude && u.book === exclude.book;
    verses.push({ book: u.book, c: u.c, v: u.v, gloss: u.gloss, score: Math.log1p(verseProminence(u.book, u.c, u.v)) + (sameBook ? 1.5 : 0) });
  }
  const read = async (x: Cand) => {
    if (x.text !== undefined) return;
    try {
      x.text = (await getPassage({ id: "BSB" }, { book: x.book, c1: x.c, v1: x.v, c2: x.c, v2: x.v }))[0]?.text ?? "";
    } catch {
      x.text = ""; // a verse the BSB numbers differently
    }
    x.mark = x.text ? markRendering(x.text, x.gloss) : null;
  };
  const byScore = [...verses].sort((a, b) => b.score - a.score);
  for (const x of byScore.slice(0, 40)) {
    await read(x);
    if (x.mark) x.score += 1;
    if (!x.text) x.score = -Infinity;
  }
  byScore.sort((a, b) => b.score - a.score);

  const picks: Cand[] = [];
  const perBook = new Map<string, number>();
  const take = (x: Cand | undefined) => {
    if (!x || x.score === -Infinity || picks.includes(x) || (perBook.get(x.book) ?? 0) >= 2 || picks.length >= limit) return;
    picks.push(x);
    perBook.set(x.book, (perBook.get(x.book) ?? 0) + 1);
  };
  const keyOf = (g: string) => contentOf(g).map(stem).join(" ");
  const common = Math.max(2, Math.ceil(verses.length * 0.05));
  for (const r of renderingsOf(verses.map((x) => x.gloss), 3).filter((r) => r.count >= common)) {
    const rk = keyOf(r.label);
    take(byScore.find((x) => keyOf(x.gloss) === rk));
  }
  for (const x of byScore) take(x);
  const idx = (b: string) => bookByUsfm(b)?.index ?? 99;
  picks.sort((a, b) => idx(a.book) - idx(b.book) || a.c - b.c || a.v - b.v);
  const key: KeyUse[] = [];
  for (const p of picks) {
    await read(p);
    if (!p.text) continue;
    key.push({ ref: verseRef(p.book, p.c, p.v), usfm: `${p.book}.${p.c}.${p.v}`, text: p.text, rendering: tidyGloss(p.gloss), mark: p.mark ?? null, sameBook: !!exclude && p.book === exclude.book });
  }
  return { key, total: verses.length };
}

// ---------- A whole word study ----------

export async function wordStudy(asked: string, at: PassageRange | null, all = false) {
  const strong = resolveStrong(asked);
  const lex = lexicon(strong);
  if (!lex) return null;
  const range = at && at.v1 !== null ? ({ book: at.book, c1: at.c1, v1: at.v1, c2: at.c2, v2: at.v2 ?? at.v1 } as Range) : null;
  const uses = usesOf(strong);
  const language: "grc" | "he" = strong.startsWith("G") ? "grc" : "he";
  const hereUse = range ? uses.find((u) => inRange(range, u.book, u.c, u.v)) : null;
  const { key, total } = await keyUses(strong, range, 6);
  const definition = lex.definition;
  return {
    strong, lemma: lex.lemma, translit: plainTranslit(lex.translit), gloss: lex.gloss, partOfSpeech: partOfSpeech(lex.pos), language,
    testament: language === "grc" ? "New Testament" : "Old Testament",
    count: uses.length, verses: new Set(uses.map((u) => `${u.book}.${u.c}.${u.v}`)).size, elsewhere: total,
    here: hereUse ? { ref: verseRef(hereUse.book, hereUse.c, hereUse.v), word: hereUse.word.replace(/[,.;:·׃]+$/, ""), translit: plainTranslit(hereUse.translit), gloss: tidyGloss(hereUse.gloss) } : null,
    renderings: renderingsOf(uses.map((u) => u.gloss)),
    key,
    senses: parseSenses(definition, language),
    definition,
    url: `https://www.stepbible.org/?q=strong=${strong.replace(/[A-Z]$/, "")}`,
    ...(all
      ? {
          all: [...new Map(uses.map((u) => [`${u.book}.${u.c}.${u.v}`, u])).values()].slice(0, 500).map((u) => ({
            ref: verseRef(u.book, u.c, u.v), usfm: `${u.book}.${u.c}.${u.v}`, rendering: tidyGloss(u.gloss), here: inRange(range, u.book, u.c, u.v),
          })),
        }
      : {}),
  };
}
export type WordStudy = NonNullable<Awaited<ReturnType<typeof wordStudy>>>;

/** The words of a passage worth a word study (nouns, verbs, adjectives, names), once each, in reading order. */
export function passageWords(range: Range, maxVerses = 6) {
  const out: { ref: string; usfm: string; c: number; v: number; word: string; translit: string; gloss: string; strong: string; lemma: string; meaning: string; count: number }[] = [];
  const seen = new Set<string>();
  let verses = 0;
  for (let c = range.c1; c <= range.c2 && verses < maxVerses; c++) {
    for (let v = c === range.c1 ? range.v1 : 1; (c < range.c2 || v <= range.v2) && verses < maxVerses; v++) {
      const ws = wordsFor(range.book, c, v);
      if (!ws.length) break;
      verses++;
      for (const w of ws) {
        if (!w.strong || seen.has(w.strong)) continue;
        const lex: LexEntry | null = lexicon(w.strong);
        if (!isContentWord(lex) && !/^N:/.test(lex?.pos ?? "")) continue;
        seen.add(w.strong);
        out.push({
          ref: verseRef(range.book, c, v), usfm: `${range.book}.${c}.${v}`, c, v, word: w.word.replace(/[,.;:·׃־]+$/, ""), translit: plainTranslit(w.translit), gloss: tidyGloss(w.gloss),
          strong: w.strong, lemma: lex!.lemma, meaning: lex!.gloss, count: useCount(w.strong),
        });
      }
    }
  }
  return out;
}
