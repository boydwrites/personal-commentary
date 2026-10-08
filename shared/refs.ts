// Passage references: one canonical form (USFM ranges), a forgiving parser, display rules,
// and pure conversions to each source's own reference format.

export interface Book {
  index: number; // 1–66, Protestant canon order
  usfm: string;
  name: string; // display name
  osis: string; // OpenBible
  hcf: string; // commentary database (lowercase, no spaces — verified against the file)
  sefaria: string | null; // null for the New Testament
  biblehub: string;
  aliases: string[];
}

// [usfm, display, osis, sefaria, biblehub, ...aliases]
const RAW: [string, string, string, string | null, string, string[]][] = [
  ["GEN", "Genesis", "Gen", "Genesis", "genesis", ["gen", "ge", "gn"]],
  ["EXO", "Exodus", "Exod", "Exodus", "exodus", ["exod", "exo", "ex"]],
  ["LEV", "Leviticus", "Lev", "Leviticus", "leviticus", ["lev", "le", "lv"]],
  ["NUM", "Numbers", "Num", "Numbers", "numbers", ["num", "nu", "nm", "nb"]],
  ["DEU", "Deuteronomy", "Deut", "Deuteronomy", "deuteronomy", ["deut", "deu", "dt", "de"]],
  ["JOS", "Joshua", "Josh", "Joshua", "joshua", ["josh", "jos", "jsh"]],
  ["JDG", "Judges", "Judg", "Judges", "judges", ["judg", "jdg", "jg", "jdgs"]],
  ["RUT", "Ruth", "Ruth", "Ruth", "ruth", ["rut", "ru", "rth"]],
  ["1SA", "1 Samuel", "1Sam", "I Samuel", "1_samuel", ["1sam", "1sa", "1 sam", "1 sa", "i samuel", "i sam", "first samuel", "1s"]],
  ["2SA", "2 Samuel", "2Sam", "II Samuel", "2_samuel", ["2sam", "2sa", "2 sam", "2 sa", "ii samuel", "ii sam", "second samuel", "2s"]],
  ["1KI", "1 Kings", "1Kgs", "I Kings", "1_kings", ["1kgs", "1ki", "1 kgs", "1 ki", "1 kings", "i kings", "first kings", "1k"]],
  ["2KI", "2 Kings", "2Kgs", "II Kings", "2_kings", ["2kgs", "2ki", "2 kgs", "2 ki", "ii kings", "second kings", "2k"]],
  ["1CH", "1 Chronicles", "1Chr", "I Chronicles", "1_chronicles", ["1chr", "1ch", "1 chr", "1 chron", "1chron", "i chronicles", "first chronicles"]],
  ["2CH", "2 Chronicles", "2Chr", "II Chronicles", "2_chronicles", ["2chr", "2ch", "2 chr", "2 chron", "2chron", "ii chronicles", "second chronicles"]],
  ["EZR", "Ezra", "Ezra", "Ezra", "ezra", ["ezr", "ez"]],
  ["NEH", "Nehemiah", "Neh", "Nehemiah", "nehemiah", ["neh", "ne"]],
  ["EST", "Esther", "Esth", "Esther", "esther", ["esth", "est", "es"]],
  ["JOB", "Job", "Job", "Job", "job", ["jb"]],
  ["PSA", "Psalms", "Ps", "Psalms", "psalms", ["psalm", "ps", "psa", "pss", "psm", "pslm"]],
  ["PRO", "Proverbs", "Prov", "Proverbs", "proverbs", ["prov", "pro", "prv", "pr"]],
  ["ECC", "Ecclesiastes", "Eccl", "Ecclesiastes", "ecclesiastes", ["eccl", "ecc", "eccles", "qoh", "qoheleth"]],
  ["SNG", "Song of Songs", "Song", "Song of Songs", "songs", ["song", "sng", "song of solomon", "song of songs", "sos", "canticles", "cant", "ss"]],
  ["ISA", "Isaiah", "Isa", "Isaiah", "isaiah", ["isa", "is"]],
  ["JER", "Jeremiah", "Jer", "Jeremiah", "jeremiah", ["jer", "je", "jr"]],
  ["LAM", "Lamentations", "Lam", "Lamentations", "lamentations", ["lam", "la"]],
  ["EZK", "Ezekiel", "Ezek", "Ezekiel", "ezekiel", ["ezek", "ezk", "eze"]],
  ["DAN", "Daniel", "Dan", "Daniel", "daniel", ["dan", "da", "dn"]],
  ["HOS", "Hosea", "Hos", "Hosea", "hosea", ["hos", "ho"]],
  ["JOL", "Joel", "Joel", "Joel", "joel", ["jol", "jl"]],
  ["AMO", "Amos", "Amos", "Amos", "amos", ["amo", "am"]],
  ["OBA", "Obadiah", "Obad", "Obadiah", "obadiah", ["obad", "oba", "ob"]],
  ["JON", "Jonah", "Jonah", "Jonah", "jonah", ["jon", "jnh"]],
  ["MIC", "Micah", "Mic", "Micah", "micah", ["mic", "mc"]],
  ["NAM", "Nahum", "Nah", "Nahum", "nahum", ["nah", "nam", "na"]],
  ["HAB", "Habakkuk", "Hab", "Habakkuk", "habakkuk", ["hab", "hb"]],
  ["ZEP", "Zephaniah", "Zeph", "Zephaniah", "zephaniah", ["zeph", "zep", "zp"]],
  ["HAG", "Haggai", "Hag", "Haggai", "haggai", ["hag", "hg"]],
  ["ZEC", "Zechariah", "Zech", "Zechariah", "zechariah", ["zech", "zec", "zc"]],
  ["MAL", "Malachi", "Mal", "Malachi", "malachi", ["mal", "ml"]],
  ["MAT", "Matthew", "Matt", null, "matthew", ["matt", "mat", "mt"]],
  ["MRK", "Mark", "Mark", null, "mark", ["mrk", "mk", "mar", "mr"]],
  ["LUK", "Luke", "Luke", null, "luke", ["luk", "lk"]],
  ["JHN", "John", "John", null, "john", ["jhn", "jn", "joh"]],
  ["ACT", "Acts", "Acts", null, "acts", ["act", "ac"]],
  ["ROM", "Romans", "Rom", null, "romans", ["rom", "ro", "rm"]],
  ["1CO", "1 Corinthians", "1Cor", null, "1_corinthians", ["1cor", "1co", "1 cor", "1 co", "i corinthians", "first corinthians"]],
  ["2CO", "2 Corinthians", "2Cor", null, "2_corinthians", ["2cor", "2co", "2 cor", "2 co", "ii corinthians", "second corinthians"]],
  ["GAL", "Galatians", "Gal", null, "galatians", ["gal", "ga"]],
  ["EPH", "Ephesians", "Eph", null, "ephesians", ["eph", "ephes"]],
  ["PHP", "Philippians", "Phil", null, "philippians", ["phil", "php", "pp"]],
  ["COL", "Colossians", "Col", null, "colossians", ["col", "co"]],
  ["1TH", "1 Thessalonians", "1Thess", null, "1_thessalonians", ["1thess", "1th", "1 thess", "1 th", "i thessalonians"]],
  ["2TH", "2 Thessalonians", "2Thess", null, "2_thessalonians", ["2thess", "2th", "2 thess", "2 th", "ii thessalonians"]],
  ["1TI", "1 Timothy", "1Tim", null, "1_timothy", ["1tim", "1ti", "1 tim", "1 ti", "i timothy"]],
  ["2TI", "2 Timothy", "2Tim", null, "2_timothy", ["2tim", "2ti", "2 tim", "2 ti", "ii timothy"]],
  ["TIT", "Titus", "Titus", null, "titus", ["tit", "ti"]],
  ["PHM", "Philemon", "Phlm", null, "philemon", ["phlm", "phm", "philem"]],
  ["HEB", "Hebrews", "Heb", null, "hebrews", ["heb"]],
  ["JAS", "James", "Jas", null, "james", ["jas", "jm"]],
  ["1PE", "1 Peter", "1Pet", null, "1_peter", ["1pet", "1pe", "1 pet", "1 pe", "1pt", "i peter"]],
  ["2PE", "2 Peter", "2Pet", null, "2_peter", ["2pet", "2pe", "2 pet", "2 pe", "2pt", "ii peter"]],
  ["1JN", "1 John", "1John", null, "1_john", ["1john", "1jn", "1 jn", "1jo", "i john", "first john"]],
  ["2JN", "2 John", "2John", null, "2_john", ["2john", "2jn", "2 jn", "2jo", "ii john"]],
  ["3JN", "3 John", "3John", null, "3_john", ["3john", "3jn", "3 jn", "3jo", "iii john"]],
  ["JUD", "Jude", "Jude", null, "jude", ["jud", "jd"]],
  ["REV", "Revelation", "Rev", null, "revelation", ["rev", "re", "revelations", "apocalypse"]],
];

export const BOOKS: Book[] = RAW.map(([usfm, name, osis, sefaria, biblehub, aliases], i) => ({
  index: i + 1,
  usfm,
  name,
  osis,
  hcf: name.toLowerCase().replace(/ /g, "").replace("songofsongs", "songofsolomon"),
  sefaria,
  biblehub,
  aliases,
}));

const byUsfm = new Map(BOOKS.map((b) => [b.usfm, b]));
const byOsis = new Map(BOOKS.map((b) => [b.osis.toLowerCase(), b]));
const aliasMap = new Map<string, Book>();
for (const b of BOOKS) {
  for (const a of [b.name.toLowerCase(), b.usfm.toLowerCase(), b.osis.toLowerCase(), b.biblehub.replace("_", " "), ...b.aliases]) {
    const key = a.replace(/\./g, "").replace(/\s+/g, " ").trim();
    if (!aliasMap.has(key)) aliasMap.set(key, b);
    aliasMap.set(key.replace(/ /g, ""), aliasMap.get(key.replace(/ /g, "")) ?? b);
  }
}

export function bookByUsfm(usfm: string): Book | undefined {
  return byUsfm.get(usfm.toUpperCase());
}
export function bookByOsis(osis: string): Book | undefined {
  return byOsis.get(osis.toLowerCase());
}
export function bookByName(name: string): Book | undefined {
  const key = name.toLowerCase().replace(/\./g, "").replace(/\s+/g, " ").trim();
  return aliasMap.get(key) ?? aliasMap.get(key.replace(/ /g, ""));
}

/** A passage range. `v1`/`v2` are null when a whole chapter was named and not yet expanded. */
export interface PassageRange {
  book: string; // USFM
  c1: number;
  v1: number | null;
  c2: number;
  v2: number | null;
}

export type ParseResult = { ok: true; range: PassageRange } | { ok: false; error: string; suggestion?: string };

const DASHES = /[‐-―−]/g;

/** Parses "Exodus 33:3", "Ex 33:3–6", "1 John 4:7-8", "John 3:16–4:2", "Psalm 23", "JHN.3.16", "PSA.23.1-3". */
export function parseReference(input: string): ParseResult {
  const raw = input.trim().replace(DASHES, "-").replace(/\s+/g, " ");
  if (!raw) return { ok: false, error: "Enter a passage, like Exodus 33:3." };

  // USFM forms: JHN.3.16, PSA.23.1-PSA.23.3, PSA.23.1-3
  const usfm = raw.match(/^([1-3]?[A-Z]{2,3})\.(\d+)(?:\.(\d+))?(?:-(?:([1-3]?[A-Z]{2,3})\.)?(\d+)(?:\.(\d+))?)?$/i);
  if (usfm && bookByUsfm(usfm[1])) {
    const book = bookByUsfm(usfm[1])!.usfm;
    const c1 = +usfm[2];
    const v1 = usfm[3] ? +usfm[3] : null;
    let c2 = c1;
    let v2 = v1;
    if (usfm[5]) {
      if (usfm[6]) {
        c2 = +usfm[5];
        v2 = +usfm[6];
      } else if (v1 !== null) v2 = +usfm[5];
      else c2 = +usfm[5];
    }
    return order({ book, c1, v1, c2, v2 });
  }

  if (/\d\s*ff\.?$/i.test(raw)) {
    return { ok: false, error: "“ff” isn't precise enough.", suggestion: raw.replace(/\s*ff\.?$/i, "") };
  }

  const m = raw.match(/^((?:[1-3]|i{1,3})?\s?[a-z][a-z .]*?)\.?\s*(\d+)(?:\s*[:.]\s*(?:vv?\.?\s*)?(\d+))?(?:\s*-\s*(\d+)(?:\s*[:.]\s*(\d+))?)?\s*$/i);
  if (!m) return { ok: false, error: "That doesn't look like a passage.", suggestion: "Exodus 33:3" };
  const book = bookByName(m[1]);
  if (!book) {
    const guess = suggestBook(m[1]);
    return { ok: false, error: `I don't recognize the book “${m[1].trim()}.”`, suggestion: guess ? raw.replace(m[1].trim(), guess.name) : undefined };
  }
  const c1 = +m[2];
  const v1 = m[3] ? +m[3] : null;
  let c2 = c1;
  let v2 = v1;
  if (m[4]) {
    if (m[5]) {
      c2 = +m[4];
      v2 = +m[5];
    } else if (v1 !== null) v2 = +m[4];
    else c2 = +m[4];
  }
  return order({ book: book.usfm, c1, v1, c2, v2 });
}

function order(r: PassageRange): ParseResult {
  if (r.c1 < 1 || r.c2 < 1 || (r.v1 !== null && r.v1 < 1) || (r.v2 !== null && r.v2 < 1)) return { ok: false, error: "Chapters and verses start at 1." };
  if (r.c2 < r.c1 || (r.c2 === r.c1 && r.v1 !== null && r.v2 !== null && r.v2 < r.v1)) {
    return { ok: false, error: "The range ends before it starts." };
  }
  return { ok: true, range: r };
}

function suggestBook(input: string): Book | undefined {
  const s = input.toLowerCase().replace(/[^a-z0-9]/g, "");
  let best: Book | undefined;
  let bestD = Infinity;
  for (const b of BOOKS) {
    const d = levenshtein(s, b.name.toLowerCase().replace(/[^a-z0-9]/g, ""));
    if (d < bestD) {
      bestD = d;
      best = b;
    }
  }
  return bestD <= 3 ? best : undefined;
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const prev = new Array(b.length + 1).fill(0).map((_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let last = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, last + (a[i - 1] === b[j - 1] ? 0 : 1));
      last = tmp;
    }
  }
  return prev[b.length];
}

/** Ordinal for overlap queries: book_index × 1,000,000 + chapter × 1,000 + verse. */
export function ordinal(book: string, chapter: number, verse: number): number {
  return bookByUsfm(book)!.index * 1_000_000 + chapter * 1_000 + verse;
}

/** Canonical USFM: "EXO.33.3" or "EXO.33.1-EXO.33.6". Range must be expanded (verses non-null). */
export function toUsfm(r: PassageRange): string {
  const a = `${r.book}.${r.c1}.${r.v1}`;
  const b = `${r.book}.${r.c2}.${r.v2}`;
  return a === b ? a : `${a}-${b}`;
}

export function fromUsfm(s: string): PassageRange | null {
  const p = parseReference(s);
  return p.ok ? p.range : null;
}

/** "Exodus 33:3", "Exodus 33:3–6", "John 3:16–4:2", "Psalm 23:1", "Psalms 23–24". */
export function displayRef(r: PassageRange): string {
  const b = bookByUsfm(r.book)!;
  const multiChapter = r.c1 !== r.c2;
  const name = b.usfm === "PSA" && !multiChapter ? "Psalm" : b.name;
  if (r.v1 === null) return multiChapter ? `${name} ${r.c1}–${r.c2}` : `${name} ${r.c1}`;
  if (!multiChapter) {
    return r.v1 === r.v2 || r.v2 === null ? `${name} ${r.c1}:${r.v1}` : `${name} ${r.c1}:${r.v1}–${r.v2}`;
  }
  return `${name} ${r.c1}:${r.v1}–${r.c2}:${r.v2}`;
}

export function displayUsfm(usfm: string): string {
  const r = fromUsfm(usfm);
  return r ? displayRef(r) : usfm;
}

// ---- conversions (one pure function per target, §13.4) ----

export function toOpenBible(book: string, c: number, v: number): string {
  return `${bookByUsfm(book)!.osis}.${c}.${v}`;
}

/** Parses an OpenBible reference or range ("Exod.32.9-Exod.32.10") into a range. */
export function fromOpenBible(s: string): PassageRange | null {
  const [a, b] = s.split("-");
  const pa = a.split(".");
  const book = bookByOsis(pa[0]);
  if (!book || pa.length < 3) return null;
  let c2 = +pa[1];
  let v2 = +pa[2];
  if (b) {
    const pb = b.split(".");
    c2 = +pb[1];
    v2 = +pb[2];
  }
  return { book: book.usfm, c1: +pa[1], v1: +pa[2], c2, v2 };
}

export function toHcfLocation(chapter: number, verse: number): number {
  return chapter * 1_000_000 + verse;
}

export function toSefaria(book: string, c: number, v?: number): string | null {
  const b = bookByUsfm(book);
  if (!b?.sefaria) return null;
  return v ? `${b.sefaria} ${c}:${v}` : `${b.sefaria} ${c}`;
}

export function toBibleHubVerseUrl(book: string, c: number, v: number): string {
  return `https://biblehub.com/commentaries/${bookByUsfm(book)!.biblehub}/${c}-${v}.htm`;
}

export function toStep(book: string, c: number, v: number): string {
  const u = bookByUsfm(book)!.usfm;
  return `${u[0]}${u.slice(1).toLowerCase()}.${c}.${v}`;
}

/** Finds references written inside free text (e.g. a post): "Exodus 33:15", "Matt 17:3", "33:15" (relative to a default book). */
export function findReferencesInText(text: string, defaultBook?: string): { text: string; start: number; end: number; range: PassageRange }[] {
  const out: { text: string; start: number; end: number; range: PassageRange }[] = [];
  const re = /\b((?:[1-3]\s?)?[A-Z][a-z]+(?:\s(?:of\s)?[A-Z][a-z]+)?\.?)\s(\d{1,3}):(\d{1,3})(?:\s?[-–—]\s?(\d{1,3})(?::(\d{1,3}))?)?/g;
  for (const m of text.matchAll(re)) {
    const book = bookByName(m[1]);
    if (!book) continue;
    const parsed = parseReference(m[0]);
    if (parsed.ok) out.push({ text: m[0], start: m.index!, end: m.index! + m[0].length, range: parsed.range });
  }
  if (defaultBook) {
    const bare = /(?<![\w:])\((\d{1,3}):(\d{1,3})(?:[-–](\d{1,3}))?\)/g;
    for (const m of text.matchAll(bare)) {
      const c = +m[1];
      const v1 = +m[2];
      out.push({ text: m[0], start: m.index!, end: m.index! + m[0].length, range: { book: defaultBook, c1: c, v1, c2: c, v2: m[3] ? +m[3] : v1 } });
    }
  }
  return out;
}
