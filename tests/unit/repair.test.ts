import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../../server/bible.ts", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../server/bible.ts")>(),
  getChapter: async () => ({
    verses: [
      { n: 21, text: "From that time on Jesus began to show His disciples that He must go to Jerusalem and suffer many things." },
      { n: 22, text: "Peter took Him aside and began to rebuke Him. “Far be it from You, Lord!” he said. “This shall never happen to You!”" },
      { n: 23, text: "But Jesus turned and said to Peter, “Get behind Me, Satan!”" },
      { n: 24, text: "Then Jesus told His disciples, “If anyone wants to come after Me, he must deny himself and take up his cross and follow Me." },
      { n: 25, text: "For whoever wants to save his life will lose it, but whoever loses his life for My sake will find it." },
    ],
  }),
}));

import { openDb, type DB } from "../../server/db.ts";
import { repairKeptCitations, runRepairs } from "../../server/repair.ts";
import { getPrefs } from "../../server/prefs.ts";

let db: DB;
const note = [
  "This verse comes after Jesus rebukes Peter for saying:",
  "> “Far be it from You, Lord!” he said. “This shall never happen to You!” — Matthew 16:24 (BSB)",
  "Peter says “you shall not suffer.” I think the same about Matthew 16:24 (BSB).",
  "> “If anyone wants to come after Me, he must deny himself — Matthew 16:24 (BSB)",
  "> he said. “This shall never happen to You!” But Jesus turned and said to Peter — Matthew 16:24 (BSB)",
  "> whoever wants to save his life will lose it — Matthew 16:24 (BSB)",
  "> I have been crucified with Christ — Galatians 2:20 (BSB)",
  "> None is forced; but if any will be a Christian — John Wesley",
].join("\n");
beforeEach(() => {
  db = openDb(":memory:");
  db.prepare(`INSERT INTO studies (id, primary_ref, display_ref, ref_start_ord, ref_end_ord, translation_id, origin, status, note, created_local_date, created_at, updated_at)
    VALUES ('study', 'MAT.16.24', 'Matthew 16:24', 40016024, 40016024, 'BSB', 'manual', 'saved', ?, '2026-10-07', '2026-10-07T12:00:00Z', '2026-10-07T12:00:00Z')`).run(note);
});
afterEach(() => db.close());

it("re-cites kept lines by the verses their words come from, and touches nothing else", async () => {
  expect(await repairKeptCitations(db)).toBe(3);
  const fixed = (db.prepare("SELECT note FROM studies").get() as any).note.split("\n");
  expect(fixed).toEqual([
    "This verse comes after Jesus rebukes Peter for saying:",
    "> “Far be it from You, Lord!” he said. “This shall never happen to You!” — Matthew 16:22 (BSB)",
    "Peter says “you shall not suffer.” I think the same about Matthew 16:24 (BSB).",
    "> “If anyone wants to come after Me, he must deny himself — Matthew 16:24 (BSB)",
    "> he said. “This shall never happen to You!” But Jesus turned and said to Peter — Matthew 16:22–23 (BSB)",
    "> whoever wants to save his life will lose it — Matthew 16:25 (BSB)",
    "> I have been crucified with Christ — Galatians 2:20 (BSB)",
    "> None is forced; but if any will be a Christian — John Wesley",
  ]);
  // The earlier text stays in history.
  expect(db.prepare("SELECT text FROM study_note_revisions WHERE kind = 'reflection' ORDER BY revision").all()).toEqual([{ text: note }, { text: fixed.join("\n") }]);
});

it("runs once", async () => {
  await runRepairs(db);
  expect(getPrefs(db).repairs).toEqual(["kept-verse-citations@1"]);
  db.prepare("UPDATE studies SET note = ?").run(note);
  await runRepairs(db);
  expect((db.prepare("SELECT note FROM studies").get() as any).note).toBe(note);
});
