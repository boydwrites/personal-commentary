import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type DB } from "../../server/db.ts";
import { researchIdentity, researchEvidenceFingerprint, researchInputFingerprint } from "../../server/research-profile.ts";
import { researchState, reusableResearchDonor, copyResearch } from "../../server/pipeline.ts";
import { setPrefs } from "../../server/prefs.ts";
import { storeSourceSnapshot, type SourceInput } from "../../server/sources/snapshots.ts";

let db: DB;
const at = "2026-10-04T12:00:00.000Z";
const source: SourceInput = { kind: "bible_text", datasetRef: "bible:fixture", title: "Exodus", locator: "Exodus 33:3", rights: "public_domain", matchLevel: "scripture", text: "Go up to a land flowing with milk and honey.", discoveredBy: "dataset" };
beforeEach(() => { db = openDb(":memory:"); study("original"); study("next"); });
afterEach(() => db.close());

function study(id: string) {
  db.prepare(`INSERT INTO studies (id, primary_ref, display_ref, ref_start_ord, ref_end_ord, translation_id, origin, status, created_local_date, created_at, updated_at)
    VALUES (?, 'EXO.33.3', 'Exodus 33:3', 2033003, 2033003, 'BSB', 'manual', 'open', '2026-10-04', ?, ?)`).run(id, at, at);
}

function fixture(scope = "neutral") {
  const { profile, compatibilityKey } = researchIdentity(db, "EXO.33.3", "BSB");
  db.prepare(`INSERT INTO research_runs (id, study_id, depth, trigger, status, prompt_version, queued_at, finished_at, research_scope, compatibility_key, research_profile_json, input_fingerprint)
    VALUES ('run', 'original', 'standard', 'manual', 'succeeded', 'fixture', ?, ?, ?, ?, ?, ?)`).run(at, at, scope, scope === "neutral" ? compatibilityKey : null, JSON.stringify(profile), "a".repeat(64));
  const sourceId = storeSourceSnapshot(db, source);
  db.prepare("INSERT INTO run_sources (run_id, source_id, stage) VALUES ('run', ?, 'P')").run(sourceId);
  db.prepare("INSERT INTO excerpts (id, run_id, short_id, source_id, start_offset, end_offset, text) VALUES ('excerpt', 'run', 'ex_01', ?, 0, ?, ?)").run(sourceId, source.text.length, source.text);
  db.prepare(`INSERT INTO cards (id, run_id, study_id, type, title, body, body_model, relationship, priority, visible_by_default, status_source, status_quote, created_at)
    VALUES ('card', 'run', 'original', 'scripture', 'The promised land', 'The promise remains.', 'The promise remains.', 'editor_synthesis', 1, 1, 'found', 'none', ?)`).run(at);
  db.prepare("INSERT INTO card_evidence (id, card_id, excerpt_id, use, match) VALUES ('evidence', 'card', 'excerpt', 'paraphrase', NULL)").run();
  db.prepare("UPDATE research_runs SET evidence_fingerprint = ? WHERE id = 'run'").run(researchEvidenceFingerprint(db, "run"));
  return { compatibilityKey, sourceId };
}

describe("neutral research boundary", () => {
  it("private notes, drafts, and writing preferences do not change a research identity", () => {
    const initial = researchIdentity(db, "EXO.33.3", "BSB");
    db.prepare("UPDATE studies SET first_observation = 'PRIVATE_INITIAL', note = 'PRIVATE_NOTE', question = 'PRIVATE_QUESTION' WHERE id = 'original'").run();
    setPrefs(db, { theologicalFrame: "PRIVATE_FRAME", careTopics: ["PRIVATE_TOPIC"], approvedExamples: ["PRIVATE_DRAFT"] });
    expect(researchIdentity(db, "EXO.33.3", "BSB")).toEqual(initial);
    expect(JSON.stringify(initial)).not.toContain("PRIVATE_");
    expect(researchIdentity(db, "EXO.33.4", "BSB").compatibilityKey).not.toBe(initial.compatibilityKey);
    expect(researchIdentity(db, "EXO.33.3", "OTHER").compatibilityKey).not.toBe(initial.compatibilityKey);
  });

  it("legacy personalized briefs cannot be automatic donors", () => {
    const { compatibilityKey } = fixture("legacy_private");
    expect(reusableResearchDonor(db, "next", compatibilityKey)).toBeUndefined();
    expect(researchState(db, "original")).toMatchObject({ researched: true, neutralReady: false, researchScope: "legacy_private" });
  });

  it("an editorial retrieval change invalidates compatibility", () => {
    const { compatibilityKey } = fixture();
    db.prepare("INSERT INTO authors (id, display_name, full_identity, tradition, created_at, updated_at) VALUES ('new-author', 'A voice', 'A voice', 'protestant', ?, ?)").run(at, at);
    const changed = researchIdentity(db, "EXO.33.3", "BSB").compatibilityKey;
    expect(changed).not.toBe(compatibilityKey);
    expect(reusableResearchDonor(db, "next", changed)).toBeUndefined();
    expect(researchState(db, "original").neutralReady).toBe(false);
  });

  it("reuses neutral research without copying selections or charging again", () => {
    const { compatibilityKey } = fixture();
    db.prepare("UPDATE cards SET selected = 1, status_interpretation = 'reviewed' WHERE id = 'card'").run();
    expect(reusableResearchDonor(db, "next", compatibilityKey)?.id).toBe("original");
    copyResearch(db, "original", "next", compatibilityKey);
    expect(db.prepare("SELECT selected, status_interpretation FROM cards WHERE study_id = 'next'").get()).toEqual({ selected: 0, status_interpretation: "unreviewed" });
    expect(researchState(db, "next").neutralReady).toBe(true);
    expect(db.prepare("SELECT COUNT(*) n FROM llm_calls").get()).toEqual({ n: 0 });
  });

  it("a later original dispute cannot be bypassed through an earlier copy", () => {
    const { compatibilityKey } = fixture();
    copyResearch(db, "original", "next", compatibilityKey);
    study("third");
    db.prepare("UPDATE cards SET status_interpretation = 'disputed', dispute_reason = 'PRIVATE_REASON' WHERE id = 'card'").run();
    expect(reusableResearchDonor(db, "third", compatibilityKey)).toBeUndefined();
  });

  it.each(["rights", "text", "excerpt", "card"])("changed %s blocks automatic reuse and permits a new neutral brief", (field) => {
    const { compatibilityKey, sourceId } = fixture();
    if (field === "rights") db.prepare("UPDATE sources SET rights = 'link_only' WHERE id = ?").run(sourceId);
    if (field === "text") db.prepare("UPDATE sources SET text = 'changed' WHERE id = ?").run(sourceId);
    if (field === "excerpt") db.prepare("UPDATE excerpts SET text = 'changed' WHERE id = 'excerpt'").run();
    if (field === "card") db.prepare("UPDATE cards SET body = 'changed' WHERE id = 'card'").run();
    expect(reusableResearchDonor(db, "next", compatibilityKey)).toBeUndefined();
    expect(researchState(db, "original").neutralReady).toBe(false);
  });

  it("a newly observed source revision invalidates an intact older brief", () => {
    const { compatibilityKey } = fixture();
    storeSourceSnapshot(db, { ...source, rights: "link_only" });
    expect(reusableResearchDonor(db, "next", compatibilityKey)).toBeUndefined();
    expect(researchState(db, "original").neutralReady).toBe(false);
  });

  it("model evidence metadata contributes to the input fingerprint", () => {
    fixture();
    expect(researchInputFingerprint(db, "run", { rendered_evidence: 'locator="one connection"' }))
      .not.toBe(researchInputFingerprint(db, "run", { rendered_evidence: 'locator="another connection"' }));
  });
});
