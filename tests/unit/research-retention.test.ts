import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { openDb, sha256, type DB } from "../../server/db.ts";
import { storeSourceSnapshot, type SourceInput } from "../../server/sources/snapshots.ts";
import { parseBibleHubChapter } from "../../server/sources/voices.ts";
import { loadRunExcerpts, verifyCard } from "../../server/verify.ts";
import { copyResearch } from "../../server/pipeline.ts";

const at = "2026-10-04T12:00:00.000Z";
const [clarke] = parseBibleHubChapter(fs.readFileSync(path.join(__dirname, "..", "fixtures", "biblehub-clarke-exodus-33.htm"), "utf8"), 33, 3, 3);
const source: SourceInput = {
  kind: "commentary_page", datasetRef: "biblehub:clarke:EXO.33.3", url: "https://biblehub.com/commentaries/clarke/exodus/33.htm",
  title: "Clarke on Exodus 33:3", authorName: "Adam Clarke", work: "Commentary", locator: "Exodus 33:3", edition: "Bible Hub",
  rights: "public_domain", matchLevel: "primary_edition", httpStatus: 200, text: clarke.text, discoveredBy: "directory",
};
let db: DB;
beforeEach(() => { db = openDb(":memory:"); });
afterEach(() => { db.close(); });

function study(id: string) {
  db.prepare(`INSERT INTO studies (id, primary_ref, display_ref, ref_start_ord, ref_end_ord, translation_id, origin, status, created_local_date, created_at, updated_at)
    VALUES (?, 'EXO.33.3', 'Exodus 33:3', 2033003, 2033003, 'BSB', 'manual', 'open', '2026-10-04', ?, ?)`).run(id, at, at);
}
function run(id: string, studyId: string, status = "succeeded", depth = "standard") {
  db.prepare(`INSERT INTO research_runs (id, study_id, depth, trigger, status, prompt_version, queued_at, finished_at)
    VALUES (?, ?, ?, 'manual', ?, 'fixture', ?, ?)`).run(id, studyId, depth, status, at, status === "running" ? null : at);
}
function evidence(sourceId: string) {
  db.prepare("INSERT INTO run_sources (run_id, source_id, stage) VALUES ('original-run', ?, 'G5')").run(sourceId);
  db.prepare(`INSERT INTO excerpts (id, run_id, short_id, source_id, start_offset, end_offset, text, refs_json)
    VALUES ('original-excerpt', 'original-run', 'E1', ?, 0, ?, ?, '[{"c":33,"v":3}]')`).run(sourceId, source.text.length, source.text);
}

describe("immutable research evidence", () => {
  it("keeps the original quotation verifiable after the same page changes", () => {
    study("original");
    run("original-run", "original");
    const originalId = storeSourceSnapshot(db, source);
    evidence(originalId);
    const original = db.prepare("SELECT * FROM sources WHERE id = ?").get(originalId) as any;
    const revisedId = storeSourceSnapshot(db, { ...source, text: "A changed page that no longer includes the original quotation." });
    expect(revisedId).not.toBe(originalId);
    expect(db.prepare("SELECT * FROM sources WHERE id = ?").get(originalId)).toEqual(original);
    const verified = verifyCard({
      body: 'Clarke discusses the words “I will not go up in the midst of thee” in the passage.',
      relationship: "direct_commentary", author: "Adam Clarke",
      evidence: [{ excerpt_id: "E1", use: "quote", quote: "I will not go up in the midst of thee" }],
    }, loadRunExcerpts(db, "original-run"), { book: "EXO", verses: [{ c: 33, v: 3 }] }, () => ({ care_note: null, condemned: false }));
    expect(verified.status_quote).toBe("matched");
    const match = verified.evidence[0];
    expect(original.text.slice(match.match_start!, match.match_end!)).toBe("I will not go up in the midst of thee");
    expect(original.content_hash).toBe(sha256(source.text));
  });

  it("reuses identical snapshots without rewriting the first retrieval date", () => {
    const id = storeSourceSnapshot(db, source);
    db.prepare("UPDATE sources SET fetched_at = ? WHERE id = ?").run(at, id);
    expect(storeSourceSnapshot(db, { ...source })).toBe(id);
    expect(db.prepare("SELECT fetched_at FROM sources WHERE id = ?").get(id)).toEqual({ fetched_at: at });
    expect(db.prepare("SELECT COUNT(*) n FROM sources").get()).toEqual({ n: 1 });
  });

  it.each([
    { rights: "link_only" }, { edition: "A revised edition" }, { authorName: "A corrected attribution" }, { matchLevel: "compiled_excerpt" },
  ])("versions evidence when provenance changes: %j", (change) => {
    const originalId = storeSourceSnapshot(db, source);
    const changedId = storeSourceSnapshot(db, { ...source, ...change });
    expect(changedId).not.toBe(originalId);
    expect(storeSourceSnapshot(db, { ...source, ...change })).toBe(changedId);
    expect((db.prepare("SELECT rights FROM sources WHERE id = ?").get(originalId) as any).rights).toBe("public_domain");
    expect((db.prepare("SELECT content_hash FROM sources WHERE id = ?").get(changedId) as any).content_hash).toBe(sha256(source.text));
  });

  it("preserves legacy source IDs and safely adds a hash before saving a changed page", () => {
    const oldId = storeSourceSnapshot(db, source);
    db.prepare("UPDATE sources SET dataset_ref = ?, content_hash = NULL WHERE id = ?").run(source.datasetRef, oldId);
    expect(storeSourceSnapshot(db, source)).toBe(oldId);
    expect((db.prepare("SELECT content_hash FROM sources WHERE id = ?").get(oldId) as any).content_hash).toBe(sha256(source.text));
    db.prepare("UPDATE sources SET content_hash = NULL WHERE id = ?").run(oldId);
    const newId = storeSourceSnapshot(db, { ...source, text: "The page changed." });
    expect(newId).not.toBe(oldId);
    expect(db.prepare("SELECT text, content_hash, dataset_ref FROM sources WHERE id = ?").get(oldId)).toEqual({ text: source.text, content_hash: sha256(source.text), dataset_ref: source.datasetRef });
  });
});

describe("prior research reuse", () => {
  it("preserves evidence and origin, starts review anew, and retains known disputes", () => {
    study("original");
    study("next");
    run("original-run", "original");
    run("active-deeper-run", "original", "running", "deeper");
    evidence(storeSourceSnapshot(db, source));
    for (const status of ["reviewed", "disputed"]) {
      db.prepare(`INSERT INTO cards (id, run_id, study_id, type, title, body, body_model, relationship, priority, visible_by_default, status_source, status_quote, status_interpretation, dispute_reason, selected, created_at)
        VALUES (?, 'original-run', 'original', 'commentary', ?, 'Kept words.', 'Kept words.', 'direct_commentary', 1, 1, 'found', 'matched', ?, ?, 1, ?)`).run(status, status, status, status === "disputed" ? "The interpretation goes beyond the text." : null, at);
      db.prepare(`INSERT INTO card_evidence (id, card_id, excerpt_id, use, quote_text, match, match_start, match_end)
        VALUES (?, ?, 'original-excerpt', 'quote', 'I will not go up in the midst of thee', 'exact', 0, 36)`).run(status, status);
    }
    db.prepare(`INSERT INTO cards (id, run_id, study_id, type, title, body, body_model, relationship, priority, visible_by_default, status_source, status_quote, created_at)
      VALUES ('active-card', 'active-deeper-run', 'original', 'commentary', 'Unfinished result', 'Pending.', 'Pending.', 'direct_commentary', 1, 1, 'found', 'none', ?)`).run(at);
    copyResearch(db, "original", "next");
    const runs = db.prepare("SELECT * FROM research_runs WHERE study_id = 'next'").all() as any[];
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "succeeded", usd_micros: 0 });
    expect(JSON.parse(runs[0].brief_json)).toMatchObject({ reused_from: { study_id: "original", run_id: "original-run" }, reuse_scope: "earlier_study_context" });
    const cards = db.prepare("SELECT * FROM cards WHERE study_id = 'next' ORDER BY title").all() as any[];
    expect(cards).toHaveLength(2);
    expect(cards[0]).toMatchObject({ title: "disputed", status_interpretation: "disputed", selected: 0, dispute_reason: "The interpretation goes beyond the text." });
    expect(cards[1]).toMatchObject({ title: "reviewed", status_interpretation: "unreviewed", selected: 0, dispute_reason: null });
    expect(JSON.parse(cards[1].data_json).reused_from).toMatchObject({ card_id: "reviewed", status_interpretation: "reviewed" });
    for (const card of cards) {
      expect(db.prepare("SELECT excerpt_id FROM card_evidence WHERE card_id = ?").get(card.id)).toEqual({ excerpt_id: "original-excerpt" });
    }
  });
});
