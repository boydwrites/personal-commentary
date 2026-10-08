import { afterEach, beforeEach, expect, it } from "vitest";
import { openDb, type DB } from "../../server/db.ts";
import { buildStudyExport } from "../../server/research-export.ts";

let db: DB;
const at = "2026-10-04T12:00:00.000Z";
beforeEach(() => {
  db = openDb(":memory:");
  db.prepare(`INSERT INTO studies (id, primary_ref, display_ref, ref_start_ord, ref_end_ord, translation_id, origin, status, first_observation, note, created_local_date, created_at, updated_at)
    VALUES ('study', 'EXO.33.3', 'Exodus 33:3', 2033003, 2033003, 'BSB', 'manual', 'open', 'First thought', 'Reflection', '2026-10-04', ?, ?)`).run(at, at);
});
afterEach(() => db.close());

it("retains both private note kinds on rapid edits and deletion without duplicate unchanged writes", () => {
  db.prepare("UPDATE studies SET first_observation = 'A second thought', note = 'A second reflection' WHERE id = 'study'").run();
  db.prepare("UPDATE studies SET first_observation = 'A third thought', note = NULL WHERE id = 'study'").run();
  db.prepare("UPDATE studies SET first_observation = 'A third thought', note = NULL WHERE id = 'study'").run();
  const notes = db.prepare("SELECT kind, text, origin FROM study_note_revisions ORDER BY rowid").all();
  expect(notes).toHaveLength(6);
  expect(notes).toEqual(expect.arrayContaining([
    { kind: "initial", text: "First thought", origin: "edit" },
    { kind: "initial", text: "A second thought", origin: "edit" },
    { kind: "initial", text: "A third thought", origin: "edit" },
    { kind: "reflection", text: "Reflection", origin: "edit" },
    { kind: "reflection", text: "A second reflection", origin: "edit" },
    { kind: "reflection", text: "", origin: "edit" },
  ]));
  expect(buildStudyExport(db, "study")!.data.study_note_revisions).toHaveLength(6);
  expect(db.prepare("SELECT revision FROM study_note_revisions WHERE kind = 'initial' ORDER BY revision").all()).toEqual([{ revision: 1 }, { revision: 2 }, { revision: 3 }]);
});

it("prevents rewriting or deleting note history", () => {
  expect(() => db.prepare("UPDATE study_note_revisions SET text = 'replacement'").run()).toThrow("immutable");
  expect(() => db.prepare("DELETE FROM study_note_revisions").run()).toThrow("immutable");
});

it("defaults older research to private rather than inferring sharing permission", () => {
  db.prepare("INSERT INTO research_runs (id, study_id, depth, trigger, status, prompt_version, queued_at) VALUES ('old', 'study', 'standard', 'manual', 'succeeded', 'old', ?)").run(at);
  expect(db.prepare("SELECT research_scope, compatibility_key, input_fingerprint FROM research_runs WHERE id = 'old'").get()).toEqual({ research_scope: "legacy_private", compatibility_key: null, input_fingerprint: null });
});

it("joins first thoughts into the notes once (migration 012), keeping both earlier texts in history", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "commentary-notebook-"));
  const file = path.join(dir, "notes.db");
  try {
    // A database from before one notebook: first thoughts and reflections kept apart.
    const before = openDb(file);
    const add = before.prepare(`INSERT INTO studies (id, primary_ref, display_ref, ref_start_ord, ref_end_ord, translation_id, origin, status, first_observation, note, created_local_date, created_at, updated_at)
      VALUES (?, 'EXO.33.3', 'Exodus 33:3', 2033003, 2033003, 'BSB', 'manual', 'open', ?, ?, '2026-10-04', ?, ?)`);
    add.run("both", "I notice the land.\n", "\nPresence matters more.", at, at);
    add.run("first", "Only first thoughts.", null, at, at);
    add.run("after", null, "Only reflections.", at, at);
    before.prepare("DELETE FROM schema_migrations WHERE version >= 12").run();
    before.close();

    const after = openDb(file);
    const rows = after.prepare("SELECT id, first_observation, note, updated_at FROM studies ORDER BY id").all();
    expect(rows).toEqual([
      { id: "after", first_observation: null, note: "Only reflections.", updated_at: at },
      { id: "both", first_observation: null, note: "I notice the land.\n\nPresence matters more.", updated_at: at },
      { id: "first", first_observation: null, note: "Only first thoughts.", updated_at: at },
    ]);
    const history = after.prepare("SELECT kind, text FROM study_note_revisions WHERE study_id = 'both' ORDER BY kind, revision").all();
    expect(history).toEqual([
      { kind: "initial", text: "I notice the land.\n" },
      { kind: "initial", text: "" },
      { kind: "reflection", text: "\nPresence matters more." },
      { kind: "reflection", text: "I notice the land.\n\nPresence matters more." },
    ]);
    expect(after.prepare("SELECT note FROM note_revisions WHERE study_id = 'both'").all()).toEqual([{ note: "I notice the land.\n\nPresence matters more." }]);
    after.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
