import { describe, it, expect } from "vitest";
import { parseReference, displayRef, toUsfm, toOpenBible, fromOpenBible, toSefaria, toBibleHubVerseUrl, toStep, ordinal, BOOKS, findReferencesInText } from "../../shared/refs.ts";
import { normalize, matchQuotation, findQuotations, dequoteSpan, gatingForm, jaccard, trigrams } from "../../shared/text.ts";
import { countPost } from "../../shared/counting.ts";

describe("reference parser", () => {
  const ok = (s: string) => {
    const p = parseReference(s);
    if (!p.ok) throw new Error(`${s}: ${p.error}`);
    return p.range;
  };
  it.each([
    ["Exodus 33:3", { book: "EXO", c1: 33, v1: 3, c2: 33, v2: 3 }],
    ["Ex 33:3", { book: "EXO", c1: 33, v1: 3, c2: 33, v2: 3 }],
    ["Exod. 33:3–6", { book: "EXO", c1: 33, v1: 3, c2: 33, v2: 6 }],
    ["Exodus 33", { book: "EXO", c1: 33, v1: null, c2: 33, v2: null }],
    ["Ps 23", { book: "PSA", c1: 23, v1: null, c2: 23, v2: null }],
    ["Psalm 23:1-3", { book: "PSA", c1: 23, v1: 1, c2: 23, v2: 3 }],
    ["1 John 4:7-8", { book: "1JN", c1: 4, v1: 7, c2: 4, v2: 8 }],
    ["1Jn 4:7", { book: "1JN", c1: 4, v1: 7, c2: 4, v2: 7 }],
    ["John 3:16–4:2", { book: "JHN", c1: 3, v1: 16, c2: 4, v2: 2 }],
    ["Song 2:4", { book: "SNG", c1: 2, v1: 4, c2: 2, v2: 4 }],
    ["Song of Songs 2:4", { book: "SNG", c1: 2, v1: 4, c2: 2, v2: 4 }],
    ["Song of Solomon 2:4", { book: "SNG", c1: 2, v1: 4, c2: 2, v2: 4 }],
    ["JHN.3.16", { book: "JHN", c1: 3, v1: 16, c2: 3, v2: 16 }],
    ["PSA.23.1-PSA.23.3", { book: "PSA", c1: 23, v1: 1, c2: 23, v2: 3 }],
    ["PSA.23.1-3", { book: "PSA", c1: 23, v1: 1, c2: 23, v2: 3 }],
    ["Romans 8:28 vv. ", { book: "ROM", c1: 8, v1: 28, c2: 8, v2: 28 }],
  ])("%s", (input, expected) => {
    expect(ok(input.trim().replace(/ vv\.$/, ""))).toEqual(expected);
  });
  it("every book's display name and aliases parse back to it", () => {
    for (const b of BOOKS) {
      expect(ok(`${b.name} 1:1`).book).toBe(b.usfm);
      for (const a of b.aliases) expect(parseReference(`${a} 1:1`).ok ? (parseReference(`${a} 1:1`) as any).range.book : a).toBe(b.usfm);
    }
  });
  it("rejects ff with a suggestion and suggests misspelled books", () => {
    const ff = parseReference("John 3:16ff");
    expect(ff.ok).toBe(false);
    expect((ff as any).suggestion).toBe("John 3:16");
    const typo = parseReference("Exodsu 33:3");
    expect((typo as any).suggestion).toBe("Exodus 33:3");
  });
  it("displays per the style rules", () => {
    expect(displayRef(ok("Exodus 33:3-6"))).toBe("Exodus 33:3–6");
    expect(displayRef(ok("Psalm 23:1"))).toBe("Psalm 23:1");
    expect(displayRef({ book: "PSA", c1: 23, v1: null, c2: 24, v2: null })).toBe("Psalms 23–24");
    expect(displayRef(ok("John 3:16–4:2"))).toBe("John 3:16–4:2");
  });
  it("converts to each source's format", () => {
    expect(toUsfm({ book: "EXO", c1: 33, v1: 1, c2: 33, v2: 23 })).toBe("EXO.33.1-EXO.33.23");
    expect(toOpenBible("EXO", 33, 3)).toBe("Exod.33.3");
    expect(fromOpenBible("Exod.32.9-Exod.32.10")).toEqual({ book: "EXO", c1: 32, v1: 9, c2: 32, v2: 10 });
    expect(toSefaria("1SA", 1, 1)).toBe("I Samuel 1:1");
    expect(toSefaria("MAT", 1, 1)).toBeNull();
    expect(toBibleHubVerseUrl("1JN", 4, 7)).toBe("https://biblehub.com/commentaries/1_john/4-7.htm");
    expect(toStep("EXO", 33, 3)).toBe("Exo.33.3");
    expect(ordinal("EXO", 33, 3)).toBe(2_033_003);
    expect(BOOKS.find((b) => b.usfm === "SNG")!.hcf).toBe("songofsolomon");
    expect(BOOKS.find((b) => b.usfm === "1SA")!.hcf).toBe("1samuel");
  });
  it("finds references in prose", () => {
    const refs = findReferencesInText("Moses (33:15) and later Matthew 17:3 and 1 John 4:8.", "EXO");
    expect(refs.map((r) => toUsfm(r.range as any))).toEqual(expect.arrayContaining(["MAT.17.3", "1JN.4.8", "EXO.33.15"]));
  });
});

describe("normalization and quotation matching", () => {
  const src = "BECAUSE I WILL NOT GO UP AMONG THEE, therefore I say to thee, I will send an angel before thee. FOR THOU ART A STIFF-NECKED PEOPLE, and if My Shechina were in thy midst and thou rebelledst against Me, I might become exceedingly angry with thee[3] and destroy thee on the way.";
  it("matches exact text despite curly quotes, dashes, and footnote markers", () => {
    expect(matchQuotation("“if My Shechina were in thy midst and thou rebelledst against Me”", src).level).toBe("exact");
    expect(matchQuotation("exceedingly angry with thee and destroy", src).level).toBe("exact");
    expect(normalize("a­b​ — “c”").text).toBe('ab - "c"');
  });
  it("matches loosely when only punctuation differs", () => {
    expect(matchQuotation("for thou art a stiff necked people and if my shechina", src).level).toBe("loose");
  });
  it("accepts elided quotations within a window", () => {
    expect(matchQuotation("I will send an angel before thee ... I might become exceedingly angry", src).level).toBe("elided");
  });
  it("never accepts a near match, but reports it", () => {
    const m = matchQuotation("if My Shechna were in thy midst and thou rebelledst against Me", src);
    expect(m.level).toBe("not_found");
    expect(m.nearMatch).toBeTruthy();
  });
  it("returns highlight offsets in the original text", () => {
    const m = matchQuotation("My Shechina", src);
    expect(src.slice(m.start!, m.end!)).toBe("My Shechina");
  });
  it("de-quotes without deleting", () => {
    const body = "Stephen says: “You stiff-necked people forever.” That is the pattern.";
    expect(dequoteSpan(body, "You stiff-necked people forever.")).toBe("Stephen says: You stiff-necked people forever. That is the pattern.");
    expect(findQuotations('Augustine said: "". Then "x y z".').map((q) => q.inner)).toEqual(["", "x y z"]);
  });
  it("gating form ignores curly quotes, trailing spaces, and line endings", () => {
    expect(gatingForm(["a “b” c  \r\n"], "")).toBe(gatingForm(['a "b" c'], ""));
    expect(gatingForm(["a"], "x")).not.toBe(gatingForm(["a"], "y"));
  });
  it("trigram similarity", () => {
    expect(jaccard(trigrams("the land was never enough"), trigrams("the land was never enough without God"))).toBeGreaterThan(0.5);
  });
});

describe("X character counting", () => {
  it("counts URLs as 23 and CJK as 2", () => {
    expect(countPost("see ccel.org").weightedLength).toBe(4 + 23);
    expect(countPost("神").weightedLength).toBe(2);
    expect(countPost("a".repeat(281)).over).toBe(true);
    expect(countPost("a".repeat(281), "long").over).toBe(false);
  });
});

describe("verse of the day (bible.com page)", async () => {
  const { parseBibleComVotd } = await import("../../server/votd.ts");
  it("reads the reference from the page title", () => {
    expect(parseBibleComVotd("<html><head><title>Verse of the Day - 2 Corinthians 10:5 - Bible App</title>")).toBe("2 Corinthians 10:5");
  });
  it("falls back to a USFM link", () => {
    expect(parseBibleComVotd('<a href="/bible/111/JHN.3.16">x</a>')).toBe("JHN.3.16");
  });
  it("returns null for a bot challenge page", () => {
    expect(parseBibleComVotd("<title>Just a moment...</title>")).toBeNull();
  });
});
