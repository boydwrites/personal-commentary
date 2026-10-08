// STEPBible: parsing the tagged Hebrew and Greek and the brief lexicons into the local index.
import { it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "commentary-stepbible-"));
process.env.COMMENTARY_DATA_DIR = tmp;
process.env.COMMENTARY_LOG_DIR = tmp;
process.env.COMMENTARY_DATASET_DIR = path.join(tmp, "datasets");
const FIX = path.join(__dirname, "..", "fixtures", "stepbible-sample.txt");

let sb: typeof import("../../server/sources/stepbible.ts");
beforeAll(async () => {
  sb = await import("../../server/sources/stepbible.ts");
  sb.buildStepbibleIndex([FIX]);
});
afterAll(() => {
  sb.closeStepbible();
  fs.rmSync(tmp, { recursive: true, force: true });
});

it("indexes Greek words with their Strong's numbers and in-verse glosses", () => {
  const words = sb.wordsFor("2CO", 10, 5);
  const captive = words.find((w) => w.strong === "G0163")!;
  expect(captive).toMatchObject({ word: "αἰχμαλωτίζοντες", translit: "aichmalōtizontes", gloss: "taking captive" });
  expect(words[0].n).toBe(1);
});

it("indexes Hebrew by its main word, joining prefixes and suffixes", () => {
  const words = sb.wordsFor("EXO", 33, 3);
  const stiff = words.find((w) => w.strong === "H7186")!;
  expect(stiff.gloss).toBe("stiff of");
  expect(words.find((w) => w.word.includes("/"))).toBeUndefined();
  // English numbering is kept where the Hebrew differs: Genesis 31:55 is Hebrew 32:1.
  expect(sb.wordsFor("GEN", 31, 55).length).toBeGreaterThan(0);
});

it("reads the lexicon, falls back to the base number, and counts uses", () => {
  const g = sb.lexicon("G0163")!;
  expect(g.lemma).toBe("αἰχμαλωτίζω");
  expect(g.definition).toContain("to take or lead captive");
  expect(g.definition).toContain("Romans 7:23"); // lexicon references are written for people
  expect(g.definition).not.toMatch(/<[a-z]/i);
  expect(sb.isContentWord(g)).toBe(true);
  expect(sb.isContentWord(sb.lexicon("G2532"))).toBe(false); // καί is a conjunction
  expect(sb.lexicon("H0776G")?.gloss).toMatch(/land/);
  const occ = sb.occurrences("G0163");
  expect(occ.count).toBe(2);
  expect(occ.refs.map((r) => `${r.book} ${r.c}:${r.v}`)).toEqual(["ROM 7:23", "2CO 10:5"]);
});

it("writes Hebrew transliteration for readers", () => {
  expect(sb.plainTranslit("za.Vat")).toBe("zavat");
  expect(sb.plainTranslit("cha.lal")).toBe("chalal");
  expect(sb.plainTranslit("aichmalōtizō")).toBe("aichmalōtizō");
});

it("labels STEP references for people", () => {
  expect(sb.stepRefLabel("2Co.10.5")).toBe("2 Corinthians 10:5");
  expect(sb.stepRefLabel("Tob.1.10")).toBeNull();
});
