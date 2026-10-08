// Synthetic page structures exercise commentary parsing; pages count only when they cite the passage.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { parseBibleHubChapter, parseEnduringWord, mentionsPassage, enduringWordUrl } from "../../server/sources/voices.ts";
import { bareRepair } from "../../server/review.ts";

const FIX = path.join(__dirname, "..", "fixtures");
const read = (f: string) => fs.readFileSync(path.join(FIX, f), "utf8");
const EXO_33_3 = { book: "EXO", c1: 33, v1: 3, c2: 33, v2: 3 };

describe("Bible Hub chapter commentaries", () => {
  it("borrows a section comment for a verse without its own, with the section's range", () => {
    const [mh] = parseBibleHubChapter(read("biblehub-mhc-exodus-33.htm"), 33, 3, 3);
    expect(mh.startVerse).toBe(1);
    expect(mh.endVerse).toBeGreaterThanOrEqual(3);
    expect(mh.text).toMatch(/^33:1-6/);
  });
  it("reads comments that aren't wrapped in a comment block (Clarke)", () => {
    const [clarke] = parseBibleHubChapter(read("biblehub-clarke-exodus-33.htm"), 33, 3, 3);
    expect(clarke.startVerse).toBe(3);
    expect(clarke.text).toContain("I will not go up in the midst of thee");
    expect(clarke.text).not.toContain("<");
  });
  it("returns nothing when a commentator is silent on the verses (Wesley on Exodus 33:3)", () => {
    expect(parseBibleHubChapter(read("biblehub-wes-exodus-33.htm"), 33, 3, 3)).toEqual([]);
  });
});

describe("Enduring Word", () => {
  it("keeps the sections whose verse range covers the passage", () => {
    const sections = parseEnduringWord(read("enduringword-exodus-33.htm"), 3, 3);
    expect(sections).toHaveLength(1);
    expect(sections[0].range).toEqual([1, 3]);
    expect(sections[0].text).toMatch(/presence/i);
  });
  it("builds chapter URLs, with Psalm singular", () => {
    expect(enduringWordUrl("JHN", 3)).toBe("https://enduringword.com/bible-commentary/john-3/");
    expect(enduringWordUrl("1JN", 4)).toBe("https://enduringword.com/bible-commentary/1-john-4/");
    expect(enduringWordUrl("PSA", 23)).toBe("https://enduringword.com/bible-commentary/psalm-23/");
  });
});

describe("a page counts only when it cites the passage", () => {
  const john = { book: "JHN", c1: 3, v1: 16, c2: 3, v2: 16 };
  it("accepts the verse, a range that covers it, and abbreviations", () => {
    expect(mentionsPassage("For God so loved the world.— John 3:16. I was surprised", john)).toBe(true);
    expect(mentionsPassage("Read John 3:14–17 tonight.", john)).toBe(true);
    expect(mentionsPassage("see Jn 3:16", john)).toBe(true);
  });
  it("rejects other verses and other books", () => {
    expect(mentionsPassage("John 3:3 speaks of new birth.", john)).toBe(false);
    expect(mentionsPassage("1 John 3:16 says we ought to lay down our lives.", john)).toBe(false);
    expect(mentionsPassage("Exodus 33:3", EXO_33_3)).toBe(true);
  });
});

describe("model repairs", () => {
  it("drops quotation marks the model wrapped around a replacement", () => {
    expect(bareRepair("“God still promises Israel the land.”", "God still gives Israel the land.")).toBe("God still promises Israel the land.");
    expect(bareRepair("\"plain\"", "word")).toBe("plain");
  });
  it("keeps them when the span itself was a quotation", () => {
    expect(bareRepair("“a stiff-necked people”", "“a stubborn people”")).toBe("“a stiff-necked people”");
    expect(bareRepair(null, "x")).toBeNull();
  });
});
