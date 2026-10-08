import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { openDb, type DB } from "../../server/db.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { studyMarkdown, writeRecord } from "../../server/records.ts";
import { NOTES_DIR } from "../../server/config.ts";
import { saveWorkingText } from "../../server/writing.ts";

vi.mock("../../server/bible.ts", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../server/bible.ts")>(),
  getChapter: async () => ({ verses: [{ n: 3, text: "Go up to a land flowing with milk and honey." }] }),
}));

let db: DB;
beforeEach(() => {
  db = openDb(":memory:");
  db.prepare(`INSERT INTO studies (id, primary_ref, display_ref, ref_start_ord, ref_end_ord, translation_id, origin, status, first_observation, note, created_local_date, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run("study", "EXO.33.3", "Exodus 33:3", 203303, 203303, "BSB", "manual", "saved", "I first noticed the promise of a land.", "Presence matters more than a destination.", "2026-10-04", "2026-10-04T12:00:00Z", "2026-10-04T12:00:00Z");
});
afterEach(() => db.close());

it("keeps each saved writing form in a portable study record", async () => {
  saveWorkingText(db, "study", { format: "journal", parts: ["Today I studied Exodus 33:3 and reconsidered what a blessing means."], source_reply: "" }, "typing");
  saveWorkingText(db, "study", { format: "devotional", parts: ["Today's devotional is from Exodus 33:3. Consider the gift of God's presence."], source_reply: "" }, "typing");
  saveWorkingText(db, "study", { format: "notes", parts: ["Initial thought: the land. What stood out: the importance of presence."], source_reply: "" }, "typing");
  const md = await studyMarkdown(db, "study");
  expect(md).toContain('app: "Personal Commentary"');
  expect(md).toContain("## Journal entry\n\nToday I studied");
  expect(md).toContain("## Devotional\n\nToday's devotional");
  expect(md).toContain("## Study notes\n\nInitial thought");
  // One notebook: anything an older client left in first thoughts comes first, then the notes.
  expect(md).toContain("## Notes\n\nI first noticed the promise of a land.\n\nPresence matters");
  // What you made comes before the notebook.
  expect(md.indexOf("## Study notes")).toBeLessThan(md.indexOf("## Notes"));
  expect(md).not.toContain("not yet posted");
  expect(md).not.toContain("Sources reply");
});

it("retains an X draft and its sources when a journal becomes the active form", async () => {
  saveWorkingText(db, "study", { format: "single", parts: ["The promised land is not the whole promise."], source_reply: "Exodus 33:3 (BSB)" }, "typing");
  saveWorkingText(db, "study", { format: "journal", parts: ["I want to keep thinking about presence."], source_reply: "" }, "typing");
  const md = await studyMarkdown(db, "study");
  expect(md).toContain("format: journal");
  expect(md).toContain("## Journal entry\n\nI want to keep thinking");
  expect(md).toContain("## The post (single post, not yet posted)");
  expect(md).toContain("The promised land is not the whole promise.");
  expect(md).toContain("**Sources reply**\n\nExodus 33:3 (BSB)");
});

it("keeps private writing alongside a published receipt", async () => {
  const post = saveWorkingText(db, "study", { format: "single", parts: ["Presence is worth more than a destination."], source_reply: "" }, "typing");
  db.prepare(`INSERT INTO posts (id, study_id, role, sequence, text, text_hash, batch_hash, channel, status, x_url, weighted_length, contains_url, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run("post", "study", "main", 0, post.parts[0], post.text_hash, post.text_hash, "composer", "posted", "https://x.com/example/status/123456", 44, 0, "2026-10-04T12:00:00Z", "2026-10-04T12:00:00Z");
  saveWorkingText(db, "study", { format: "journal", parts: ["These are the personal reflections I kept after sharing."], source_reply: "" }, "typing");
  const md = await studyMarkdown(db, "study");
  expect(md).toContain("## Posted to X");
  expect(md).toContain("[view on X](https://x.com/example/status/123456)");
  expect(md).toContain("## Journal entry\n\nThese are the personal reflections");
  expect(md.match(/Presence is worth more than a destination\./g)).toHaveLength(1);
});

it("lists highlighted findings in the record, after the notes", async () => {
  db.prepare("INSERT INTO research_runs (id, study_id, depth, trigger, status, prompt_version, queued_at) VALUES ('run', 'study', 'standard', 'manual', 'succeeded', 'test', '2026-10-04T12:00:00Z')").run();
  db.prepare(`INSERT INTO cards (id, run_id, study_id, type, title, body, body_model, relationship, priority, visible_by_default, status_source, status_quote, status_interpretation, selected, section, created_at)
    VALUES ('card', 'run', 'study', 'connection', 'Presence goes with them', 'Moses will not go without God.', 'Moses will not go without God.', 'scripture', 1, 1, 'found', 'none', 'unreviewed', 1, 'scripture', '2026-10-04T12:00:00Z')`).run();
  const md = await studyMarkdown(db, "study");
  expect(md).toMatch(/## Notes[\s\S]*## Highlights\n\n- \*\*Presence goes with them\*\*[\s\S]*## Study brief/);
  expect(md).toContain("_★ marks what I highlighted._");
});

it("never rewrites a record outside this instance's notes folder", async () => {
  // A copied database (a sandbox or test instance) still points at the original's files.
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "commentary-elsewhere-"));
  const original = path.join(elsewhere, "2026-10-04 Exodus 33.3.md");
  fs.writeFileSync(original, "the owner's real record");
  db.prepare("UPDATE studies SET record_path = ? WHERE id = 'study'").run(original);
  const written = await writeRecord(db, "study");
  expect(fs.readFileSync(original, "utf8")).toBe("the owner's real record");
  expect(path.resolve(written).startsWith(path.resolve(NOTES_DIR) + path.sep)).toBe(true);
  expect((db.prepare("SELECT record_path FROM studies WHERE id = 'study'").get() as any).record_path).toBe(written);
  fs.rmSync(elsewhere, { recursive: true, force: true });
});

it("sets kept lines apart as quotations, and nests a piece's headings under its own", async () => {
  db.prepare("UPDATE studies SET first_observation = NULL, note = ? WHERE id = 'study'")
    .run("Peter protests:\n> “This shall never happen to You!” — Matthew 16:22 (BSB)\nJesus answers him.\n> If anyone wants to come after Me — Matthew 16:24 (BSB)\n> Whoever loses his life — Matthew 16:25 (BSB)");
  saveWorkingText(db, "study", { format: "notes", parts: ["Peter and the cross.\n\n## Peter's protest\n\nHe resists.\n\n### A detail\n\nMore."], source_reply: "" }, "typing");
  const md = await studyMarkdown(db, "study");
  expect(md).toContain("## Notes\n\nPeter protests:\n\n> “This shall never happen to You!” — Matthew 16:22 (BSB)\n\nJesus answers him.\n\n> If anyone wants to come after Me — Matthew 16:24 (BSB)\n\n> Whoever loses");
  expect(md).toContain("## Study notes\n\nPeter and the cross.\n\n### Peter's protest\n\nHe resists.\n\n#### A detail");
});
