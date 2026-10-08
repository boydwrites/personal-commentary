// Word studies: how one Hebrew or Greek word reads, renders, and recurs (server/words.ts). Local data only.
import { it, expect, beforeAll, afterAll, describe } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "commentary-words-"));
process.env.COMMENTARY_DATA_DIR = tmp;
process.env.COMMENTARY_LOG_DIR = tmp;
process.env.COMMENTARY_DATASET_DIR = path.join(tmp, "datasets");
const FIX = path.join(__dirname, "..", "fixtures", "stepbible-sample.txt");

let sb: typeof import("../../server/sources/stepbible.ts");
let w: typeof import("../../server/words.ts");
beforeAll(async () => {
  sb = await import("../../server/sources/stepbible.ts");
  w = await import("../../server/words.ts");
  sb.buildStepbibleIndex([FIX]);
});
afterAll(() => {
  sb.closeStepbible();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// STEPBible's brief lexicon (CC BY 4.0) for διακρίνω, as lexText leaves it.
const DIAKRINO = `δια-κρίνω
[in LXX for שׁפט, דִּין, etc. ;]
__1. to separate, hence, to distinguish, discriminate, discern: μηδὲν δ., Acts 11:12 οὐδὲν δ. μεταξύ, Acts 15:9 σε, 1 Corinthians 4:7 τὸ σῶμα, 1 Corinthians 11:29
__2. to settle, decide, judge, arbitrate: Matthew 16:3, 1 Corinthians 6:5 (ICC, in l.), ib. 31 14:29. Mid, and pass.;
__1. to get a decision, contend, dispute: before πρός, Acts 11:2 with dative (but see ICC, in l.), Jude.9; absol., Jude.22 (R,mg.).
__2. Hellenistic (NT and Eccl., but not LXX), to be divided in one's mind, to hesitate, doubt: Matthew 21:21 Romans 14:23, James 1:6; ἐν ἐαυτῷ, James 2:4
(AS)`;
const SHALOM = `peace
1) completeness, soundness, welfare, peace
1a) completeness (in number)
1e) peace, friendship
1e1) of human relationships`;
const ELEEO = `ἐλεέω
(in Romans 9:16, Jude.22, -άω, which see), -ῶ (ἔλεος), [in LXX chiefly for חָנַן ;]
to have pity or mercy on, to show mercy: absol., Romans 9:16; with accusative, Matthew 9:27. Pass., to have pity or mercy shown one (EV, obtain mercy): Matthew 5:7, Romans 11:30.†
(AS)`;

describe("what a word means", () => {
  it("reads a Greek entry as numbered senses with their verses, without the scholarly apparatus", () => {
    const senses = w.parseSenses(DIAKRINO, "grc");
    expect(senses.map((s) => s.text)).toEqual([
      "to separate, hence, to distinguish, discriminate, discern",
      "to settle, decide, judge, arbitrate",
      "Of oneself (its middle and passive forms)",
      "to get a decision, contend, dispute",
      "to be divided in one's mind, to hesitate, doubt",
    ]);
    expect(senses[0].refs).toEqual(["Acts 11:12", "Acts 15:9", "1 Corinthians 4:7", "1 Corinthians 11:29"]);
    expect(senses[2].heading).toBe(true);
    expect(senses.at(-1)!.refs).toContain("James 1:6");
  });

  it("splits a line that turns to the passive, and skips forms and etymology", () => {
    expect(w.parseSenses(ELEEO, "grc").map((s) => s.text)).toEqual(["to have pity or mercy on, to show mercy", "(passive) to have pity or mercy shown one"]);
  });

  it("reads a Hebrew entry by its outline, leaving out the bare gloss", () => {
    const senses = w.parseSenses(SHALOM, "he");
    expect(senses.map((s) => [s.label, s.depth])).toEqual([["1", 0], ["1a", 1], ["1e", 1], ["1e1", 2]]);
  });

  it("names the kind of word", () => {
    expect(w.partOfSpeech("G:V")).toBe("verb");
    expect(w.partOfSpeech("H:N-M")).toBe("noun (masculine)");
    expect(w.partOfSpeech("N:N--L")).toBe("name");
  });
});

describe("how English renders it", () => {
  it("groups the forms of one rendering and counts them", () => {
    const r = w.renderingsOf(["doubting,", "shall doubt,", "may doubt", "to discern,", "discerning", "were contending", "He made distinction"]);
    expect(r[0]).toEqual({ label: "doubt", count: 3 });
    expect(r[1]).toEqual({ label: "discern", count: 2 });
    expect(r.map((x) => x.label)).toContain("distinction");
  });

  it("writes STEPBible's English for readers", () => {
    expect(w.tidyGloss("heart your")).toBe("your heart");
    expect(w.tidyGloss("in heart my")).toBe("in my heart");
    expect(w.tidyGloss("with <the> peace,")).toBe("with the peace");
    expect(w.tidyGloss("[the] welfare of")).toBe("the welfare of");
  });

  it("finds the word in the BSB verse when the BSB uses it", () => {
    const text = "“Truly I tell you,” Jesus replied, “if you have faith and do not doubt, not only will you do what was done to the fig tree…";
    const m = w.markRendering(text, "shall doubt,")!;
    expect(text.slice(m[0], m[1])).toBe("doubt");
    expect(w.markRendering("You know how to interpret the appearance of the sky", "to discern")).toBeNull();
  });
});

describe("a word study from the tagged text", () => {
  it("says how the word reads in the verse and lists the passage's words to study", async () => {
    const study = (await w.wordStudy("G0163", { book: "2CO", c1: 10, v1: 5, c2: 10, v2: 5 }))!;
    expect(study).toMatchObject({ lemma: "αἰχμαλωτίζω", language: "grc", testament: "New Testament", count: 2, here: { ref: "2 Corinthians 10:5", gloss: "taking captive" } });
    expect(study.senses[0].text).toBe("to take or lead captive");
    // Without the BSB downloaded there's no verse text to show, so no verse is listed rather than an empty one.
    expect(study.key).toEqual([]);
    const words = w.passageWords({ book: "2CO", c1: 10, v1: 5, c2: 10, v2: 5 });
    expect(words.find((x) => x.strong === "G0163")).toMatchObject({ usfm: "2CO.10.5", gloss: "taking captive", count: 2 });
    expect(words.find((x) => x.strong === "G2532")).toBeUndefined(); // καί isn't a word to study
  });
});
