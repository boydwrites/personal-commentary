import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { fakeModel } from "../fixtures/fake-model.ts";

const fixture = vi.hoisted(() => {
  return { call: vi.fn() };
});
vi.mock("../../server/llm.ts", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../server/llm.ts")>(), callStructured: fixture.call,
}));
vi.mock("../../server/secrets.ts", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../server/secrets.ts")>(), getSecret: () => null,
}));
vi.mock("../../server/bible.ts", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../server/bible.ts")>(),
  getChapter: async () => ({ verses: [{ n: 3, id: "EXO.33.3", text: "Go up to a land flowing with milk and honey." }] }),
  getPassage: async () => [{ chapter: 33, n: 3, id: "EXO.33.3", text: "Go up to a land flowing with milk and honey." }],
}));

import { openDb, type DB } from "../../server/db.ts";
import { draft, sharpen, getWorkingText, getWorkingTextVariants, saveWorkingText, switchWritingFormat, voiceSamples } from "../../server/writing.ts";
import { computeGate, deterministicReview, modelReview } from "../../server/review.ts";
import { startPublish } from "../../server/publish.ts";
import type { WritingFormat } from "../../shared/writing.ts";
import { registerRoutes } from "../../server/routes.ts";

let db: DB;
let app: FastifyInstance;
const thoughts = "I noticed that God still promises the land after the golden calf, but his presence is withheld.";
function addStudy(id = "study") {
  db.prepare(`INSERT INTO studies (id, primary_ref, display_ref, ref_start_ord, ref_end_ord, translation_id, origin, status, first_observation, note, created_local_date, created_at, updated_at)
    VALUES (?, 'EXO.33.3', 'Exodus 33:3', 203303, 203303, 'BSB', 'manual', 'open', ?, '', '2026-10-04', '2026-10-04T12:00:00Z', '2026-10-04T12:00:00Z')`).run(id, thoughts);
}
function save(format: WritingFormat, text: string, cause = "typing") {
  return saveWorkingText(db, "study", { format, parts: [text], source_reply: "" }, cause);
}
beforeEach(() => {
  db = openDb(":memory:");
  addStudy();
  app = Fastify();
  registerRoutes(app, db);
  fixture.call.mockReset().mockImplementation(async (a: any) => ({ data: fakeModel({ input: [{ content: a.user }] }), callId: "fixture" }));
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected live request in writing tests"); }));
});
afterEach(async () => { await app.close(); db.close(); vi.unstubAllGlobals(); });

describe("writing route ownership and conflict protection", () => {
  it("rejects applying a draft from another study", async () => {
    addStudy("another");
    const d = await draft(db, "another", "edit", "journal");
    const response = await app.inject({ method: "POST", url: `/api/studies/study/drafts/${d.id}/apply` });
    expect(response.statusCode).toBe(404);
    expect(getWorkingText(db, "study")).toBeNull();
  });

  it("rejects a stale empty-tab hash for save, switch, and apply", async () => {
    const d = await draft(db, "study", "edit", "journal");
    const current = save("journal", "Words saved in another tab.");
    const saveResponse = await app.inject({ method: "PUT", url: "/api/studies/study/working-text", payload: { format: "journal", parts: ["Stale words"], base_hash: null } });
    const switchResponse = await app.inject({ method: "POST", url: "/api/studies/study/writing-format", payload: { format: "notes", base_hash: null } });
    const applyResponse = await app.inject({ method: "POST", url: `/api/studies/study/drafts/${d.id}/apply`, payload: { base_hash: null } });
    expect([saveResponse.statusCode, switchResponse.statusCode, applyResponse.statusCode]).toEqual([409, 409, 409]);
    expect(getWorkingText(db, "study")).toEqual(current);
  });

  it("restores the target workspace and returns history for the active form", async () => {
    save("journal", "My first journal draft.");
    const other = save("notes", "Notes on the verse.");
    const response = await app.inject({ method: "POST", url: "/api/studies/study/writing-format", payload: { format: "journal", base_hash: other.text_hash } });
    expect(response.statusCode).toBe(200);
    expect(response.json().working).toMatchObject({ format: "journal", parts: ["My first journal draft."] });
    const history = (await app.inject({ method: "GET", url: "/api/studies/study/history" })).json();
    expect(history.post.length).toBeGreaterThan(0);
    expect(history.post.every((r: any) => r.format === "journal")).toBe(true);
    const staleSave = await app.inject({ method: "PUT", url: "/api/studies/study/working-text", payload: { format: "notes", parts: ["Stale notes"], base_hash: other.text_hash, base_format: "notes" } });
    expect(staleSave.statusCode).toBe(409);
  });
});

describe("independent writing forms", () => {
  it("restores every form, keeps its origin, and leaves all text searchable", () => {
    const journal = saveWorkingText(db, "study", { format: "journal", parts: ["A journal about presence."], source_reply: "" }, "draft_applied", "journal-origin");
    const empty = switchWritingFormat(db, "study", "devotional");
    expect(empty.parts).toEqual([""]);
    expect(empty.origin_draft_id).toBeNull();
    save("devotional", "A devotional about mercy.");
    const restored = switchWritingFormat(db, "study", "journal");
    expect(restored).toMatchObject({ parts: journal.parts, text_hash: journal.text_hash, origin_draft_id: "journal-origin" });
    switchWritingFormat(db, "study", "notes");
    expect(getWorkingTextVariants(db, "study").find((v) => v.format === "devotional")?.parts).toEqual(["A devotional about mercy."]);
    expect(db.prepare("SELECT COUNT(*) n FROM search_index WHERE search_index MATCH 'presence'").get()).toMatchObject({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) n FROM search_index WHERE search_index MATCH 'mercy'").get()).toMatchObject({ n: 1 });
  });

  it("records text before a suggestion is applied, with the correct form", () => {
    const original = save("journal", "My own careful edits.");
    save("journal", "A polished version of my edits.", "sharpen");
    const history = db.prepare("SELECT * FROM text_revisions WHERE study_id = 'study' AND format = 'journal'").all() as any[];
    expect(history.some((r) => r.text_hash === original.text_hash)).toBe(true);
    expect(history.some((r) => r.cause === "sharpen")).toBe(true);
  });

  it("does not carry an X review into prose with identical wording", async () => {
    const x = save("single", "The land was a gift.");
    db.prepare("INSERT INTO reviews (id, study_id, kind, text_hash, created_at) VALUES ('review', 'study', 'model', ?, '2026-10-04T12:00:00Z')").run(x.text_hash);
    expect((await computeGate(db, "study")).gate.modelReview).toBe("current");
    const journal = save("journal", x.parts[0]);
    expect(journal.text_hash).not.toBe(x.text_hash);
    expect((await computeGate(db, "study")).gate).toMatchObject({ modelReview: "stale", canPublish: false });
  });

  it("normalizes prose to one text and omits an invisible source reply", () => {
    const w = saveWorkingText(db, "study", { format: "journal", parts: ["First paragraph.", "Second paragraph."], source_reply: "Hidden source reply." }, "typing");
    expect(w.parts).toEqual(["First paragraph.\n\nSecond paragraph."]);
    expect(w.source_reply).toBe("");
  });
});

describe("first draft and refinements", () => {
  it.each(["journal", "devotional", "notes"] as const)("creates %s as one editable text from a recorded fixture", async (format) => {
    const d = await draft(db, "study", "edit", format);
    expect(d.format).toBe(format);
    expect(d.parts).toHaveLength(1);
    expect(d.parts[0].length).toBeGreaterThan(280);
    expect(d.source_reply).toBe("");
    expect(fixture.call).toHaveBeenCalledWith(expect.objectContaining({ stage: "draft", promptVersion: "draft@9" }));
    expect(fixture.call.mock.calls[0][0].user).toContain(thoughts);
    expect(getWorkingText(db, "study")).toBeNull();
  });

  it("drafts without notes, building on another piece, and refuses only when there's nothing to stand on", async () => {
    db.prepare("UPDATE studies SET first_observation = '', note = '> These are copied research words that the user saved but did not write in their own words.'").run();
    await expect(draft(db, "study", "edit", "journal")).rejects.toThrow(/nothing to draft from/);
    expect(fixture.call).not.toHaveBeenCalled();
    save("notes", "The land is promised; the presence is withheld. That is the whole crisis of Exodus 33.");
    await draft(db, "study", "edit", "single");
    const prompt: string = fixture.call.mock.calls[0][0].user;
    expect(prompt).toContain("Already written from this study");
    expect(prompt).toContain("--- Study notes ---\nThe land is promised; the presence is withheld.");
    expect(prompt).toContain("hasn't written separate notes");
  });

  it("names an untitled study from its first draft, and never replaces a title you typed", async () => {
    fixture.call.mockImplementation(async (a: any) => ({ data: { ...fakeModel({ input: [{ content: a.user }] }), title: "“Land Without Presence.”" }, callId: "fixture" }));
    await draft(db, "study", "edit", "journal");
    expect(db.prepare("SELECT title, title_auto FROM studies WHERE id = 'study'").get()).toEqual({ title: "Land Without Presence", title_auto: 1 });
    expect((await app.inject({ method: "PATCH", url: "/api/studies/study", payload: { title: "My own name" } })).statusCode).toBe(200);
    await draft(db, "study", "edit", "devotional");
    expect(db.prepare("SELECT title, title_auto FROM studies WHERE id = 'study'").get()).toEqual({ title: "My own name", title_auto: 0 });
    // "Choose for me" replaces it only when asked, and marks it chosen.
    fixture.call.mockResolvedValueOnce({ callId: "fixture", data: { title: "Presence Over Promise" } });
    const r = await app.inject({ method: "POST", url: "/api/studies/study/title", payload: { previous: ["Land Without Presence"] } });
    expect(r.json()).toEqual({ title: "Presence Over Promise" });
    expect(fixture.call.mock.calls.at(-1)![0]).toMatchObject({ stage: "title", promptVersion: "title@2" });
    expect(fixture.call.mock.calls.at(-1)![0].user).toContain("Land Without Presence");
    expect(db.prepare("SELECT title, title_auto FROM studies WHERE id = 'study'").get()).toEqual({ title: "Presence Over Promise", title_auto: 1 });
  });

  it("keeps the requested format even when the model suggests another", async () => {
    fixture.call.mockResolvedValue({ callId: "fixture", data: { format: "thread", parts: ["One.", "Two."], hook: "One.", alternate_openings: [], drew_on: [], left_out: [], claim_map: [], source_reply: "", notes_for_writer: "" } });
    const single = await draft(db, "study", "edit", "single");
    expect(single).toMatchObject({ format: "single", parts: ["One.\n\nTwo."] });
    fixture.call.mockResolvedValue({ callId: "fixture", data: { ...single, format: "single", parts: ["Only part."], drew_on: [], left_out: [], claim_map: [], alternate_openings: [] } });
    expect(await draft(db, "study", "edit", "thread")).toMatchObject({ format: "thread", parts: ["Only part."] });
  });

  it("refines the latest saved edits repeatedly without replacing anything until accepted", async () => {
    const current = save("journal", "My initial thoughts centered on God's presence. These are my own latest edits.");
    const suggestion = await sharpen(db, "study", { mode: "shorten", instruction: "Keep the final sentence." });
    expect(suggestion.original).toEqual(current.parts);
    expect(suggestion.base_hash).toBe(current.text_hash);
    expect(suggestion.changes[0].separable).toBe(true);
    expect(getWorkingText(db, "study")?.parts).toEqual(current.parts);
    expect(fixture.call.mock.calls[0][0].user).toContain("Shorten noticeably");
    expect(fixture.call.mock.calls[0][0].user).toContain("Keep the final sentence.");
    saveWorkingText(db, "study", { format: "journal", parts: suggestion.parts, source_reply: "" }, "sharpen");
    await sharpen(db, "study", { mode: "clarify" });
    expect(fixture.call.mock.calls[1][0].user).toContain(suggestion.parts[0]);
    expect(fixture.call.mock.calls[1][0].user).toContain("Clarify the reasoning");
  });

  it.each(["Changed “the words inside” carelessly.", "Removed the quotation marks around the original words.", "Kept “the original words” and invented “another quotation”."])("rejects quotation-changing refinements: %s", async (changed) => {
    const original = save("journal", "Kept “the original words” carefully.");
    fixture.call.mockResolvedValue({ callId: "fixture", data: { parts: [changed], changes: [], note: "" } });
    const result = await sharpen(db, "study");
    expect(result.parts).toEqual(original.parts);
    expect(result.unchanged).toBe(true);
    expect(result.notes).toContain("Quotations stay exactly");
  });

  it("keeps the writer's text if a refinement returns an empty part", async () => {
    const original = save("journal", "This is my reflection, which must not disappear.");
    fixture.call.mockResolvedValue({ callId: "fixture", data: { parts: [""], changes: [], note: "" } });
    expect((await sharpen(db, "study")).parts).toEqual(original.parts);
  });
});

describe("your voice on X", () => {
  /** Another study whose X post started from a draft: kept as drafted, or rewritten. */
  function postIn(id: string, drafted: string, final: string, at: string) {
    addStudy(id);
    db.prepare(`INSERT INTO drafts (id, study_id, kind, format, parts_json, card_ids_json, note_snapshot, created_at) VALUES (?, ?, 'edit', 'single', ?, '[]', '', ?)`).run(`d-${id}`, id, JSON.stringify([drafted]), at);
    saveWorkingText(db, id, { format: "single", parts: [final], source_reply: "" }, "typing", `d-${id}`);
    db.prepare("UPDATE working_text_variants SET updated_at = ? WHERE study_id = ?").run(at, id);
  }
  const offered = "Psalm 51:10 uses bara for create, the same verb as Genesis 1:1. Our inner selves may become sick. God can restore us.";
  const rewritten = "The word “create” in Psalm 51:10 is bara, the same Hebrew verb as Genesis 1:1.\n\nThe voice that spoke the world into being can speak to your heart and make it clean.";

  it("learns from posts you rewrote or posted, never from a draft you kept word for word", () => {
    postIn("rewrote", offered, rewritten, "2026-10-05T12:00:00Z");
    postIn("kept", "A draft kept exactly as offered.", "A draft kept exactly as offered.", "2026-10-06T12:00:00Z");
    save("single", "This study's own post, which is never its own example.");
    const v = voiceSamples(db, "study");
    expect(v.ownPosts).toEqual([{ ref: "Exodus 33:3", text: rewritten, posted: false }]);
    expect(v.edits).toEqual([{ ref: "Exodus 33:3", draft: offered, final: rewritten }]);
  });

  it("drafts an X post from your posts and the posts you like, and leaves prose drafts alone", async () => {
    postIn("rewrote", offered, rewritten, "2026-10-05T12:00:00Z");
    addStudy("own");
    saveWorkingText(db, "own", { format: "single", parts: ["A post I wrote myself, with no draft behind it."], source_reply: "" }, "typing");
    await app.inject({ method: "PUT", url: "/api/preferences", payload: { approvedExamples: ["A post I like.\n\nWith a second line."] } });
    await draft(db, "study", "edit", "single");
    const x = fixture.call.mock.calls.at(-1)![0].user as string;
    expect(x).toContain("Posts the user wrote");
    expect(x).toContain("A post I wrote myself, with no draft behind it.");
    expect(x).toContain("How the user rewrites a draft");
    expect(x).toContain("The voice that spoke the world into being");
    expect(x).toContain("Example 1: A post I like.\n\nWith a second line.");
    await draft(db, "study", "edit", "journal");
    expect(fixture.call.mock.calls.at(-1)![0].user).not.toContain("How the user rewrites a draft");
    const voice = (await app.inject({ method: "GET", url: "/api/voice?except=study" })).json();
    expect(voice.own.map((p: any) => p.text)).toEqual(["A post I wrote myself, with no draft behind it.", rewritten]);
    expect(voice.liked).toEqual(["A post I like.\n\nWith a second line."]);
  });
});

describe("one notebook", () => {
  it("drafts from your notes as one text", async () => {
    db.prepare("UPDATE studies SET first_observation = NULL, note = ? WHERE id = 'study'").run(`${thoughts}\n\n> Go up to a land flowing with milk and honey. — Exodus 33:3 (BSB)\n\nThe gift without the Giver.`);
    await draft(db, "study", "edit", "notes");
    const user = fixture.call.mock.calls.at(-1)![0].user as string;
    expect(user).toContain(`The user's notes:\n${thoughts}`);
    expect(user).toContain("The gift without the Giver.");
    expect(user).not.toMatch(/Initial thoughts:|What stood out/);
  });
});

describe("proportionate review", () => {
  it("also blocks an unmatched quotation shorter than four words", async () => {
    const w = save("journal", "The supposed promise is “guaranteed prosperity”.");
    expect((await deterministicReview(db, "study", w)).some((f) => f.code === "D5" && f.severity === "blocker")).toBe(true);
  });
  it("retains evidence and placeholder blockers without X length/link rules", async () => {
    const w = save("devotional", "Study reflection. ".repeat(40) + ' https://example.com #one #two TODO “An invented sentence with no source anywhere.”');
    const codes = (await deterministicReview(db, "study", w)).map((f) => f.code);
    expect(codes).toContain("D5");
    expect(codes).toContain("D3");
    expect(codes).not.toContain("D1");
    expect(codes).not.toContain("D8");
    expect(codes).not.toContain("D14");
  });

  it("refuses publishing prose even after its review is current", async () => {
    const w = save("notes", "Notes about the passage.");
    await modelReview(db, "study");
    expect((await computeGate(db, "study")).gate).toMatchObject({ modelReview: "current", canPublish: false });
    await expect(startPublish(db, "study", w.text_hash)).rejects.toThrow(/isn't an X post/);
    expect(db.prepare("SELECT COUNT(*) n FROM posts").get()).toMatchObject({ n: 0 });
  });
});
