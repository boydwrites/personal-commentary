import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb, sha256, type DB } from "../../server/db.ts";
import { approveResearchCorpus, buildResearchCorpusExport, inspectResearchCorpus, revokeResearchCorpus } from "../../server/research-corpus.ts";
import { buildStudyExport } from "../../server/research-export.ts";
import { researchEvidenceFingerprint } from "../../server/research-profile.ts";
import { CORPUS_AT, insertCorpusRow, PRIVATE_SENTINEL, seedResearchCorpus } from "../fixtures/research-corpus.ts";

let db: DB;
const studyId = "private-study";
const stamp = () => db.prepare("UPDATE research_runs SET evidence_fingerprint = ? WHERE id = 'neutral-run'").run(researchEvidenceFingerprint(db, "neutral-run"));
const approval = () => ({ expectedHash: inspectResearchCorpus(db, studyId)!.hash, reviewedPrivacy: true, reviewedQuality: true, reviewedRights: true,
  sourceRights: inspectResearchCorpus(db, studyId)!.dependencies.map((s) => ({ sourceId: s.sourceId, licenseUrl: "https://example.org/public-domain", attribution: "Source author, public-domain edition", provenanceUrl: "https://example.org/edition" })) });

beforeEach(() => {
  db = openDb(":memory:");
  seedResearchCorpus(db);
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Corpus operations must stay local"); }));
});
afterEach(() => { db.close(); vi.unstubAllGlobals(); });

describe("local research corpus boundary", () => {
  it("requires explicit reviews then stores only allowlisted neutral data in a separate immutable package", () => {
    const inspection = inspectResearchCorpus(db, studyId)!;
    expect(inspection.status).toBe("needs_review");
    expect(inspection.preview!.artifacts[0].displayBody).toContain("Moses");
    expect(JSON.stringify(inspection.preview)).not.toContain(PRIVATE_SENTINEL);
    expect(() => buildResearchCorpusExport(db, studyId)).toThrow("no current corpus approval");
    expect(() => approveResearchCorpus(db, studyId, { ...approval(), reviewedPrivacy: false })).toThrow("each need your review");
    expect(() => approveResearchCorpus(db, studyId, { ...approval(), sourceRights: [] })).toThrow("Every source needs");
    const approved = approveResearchCorpus(db, studyId, approval());
    expect(approved.status).toBe("approved");
    const result = buildResearchCorpusExport(db, studyId)!;
    expect(result.format).toBe("personal-commentary.research-corpus");
    expect(result.manifest.cloudSyncEnabled).toBe(false);
    expect(result.manifest.dataSha256).toBe(sha256(JSON.stringify(result.data)));
    expect(result.manifest.sourceRights[0]).toMatchObject({ sourceId: "source-one", attribution: "Source author, public-domain edition" });
    expect(result.manifest.totalCostMicros).toBe(123); // the call and run totals are not charged again
    expect(JSON.stringify(result)).not.toContain(PRIVATE_SENTINEL);
    expect(JSON.stringify(result)).not.toContain(studyId);
    expect(JSON.stringify(result)).not.toMatch(/study_id|request_json|response_json|dispute_reason|selected|data_json|reused_from/);
    const saved = db.prepare("SELECT * FROM research_corpus_packages").get() as any;
    expect(saved.content_hash).toBe(inspection.hash);
    expect(saved.data_json).toBe(JSON.stringify(result.data));
    expect(JSON.stringify(saved)).not.toContain(PRIVATE_SENTINEL);
    expect(() => db.prepare("UPDATE research_corpus_packages SET data_json = '{}' ").run()).toThrow("immutable");
    expect(() => db.prepare("DELETE FROM research_corpus_decisions").run()).toThrow("immutable");
    expect(JSON.stringify(buildStudyExport(db, studyId))).toContain(PRIVATE_SENTINEL);
  });

  it.each(["public_domain", "cc_by"])("does not treat %s as a substitute for recorded rights review", (rights) => {
    db.prepare("UPDATE sources SET rights = ? WHERE id = 'source-one'").run(rights);
    stamp();
    expect(inspectResearchCorpus(db, studyId)!.status).toBe("needs_review");
    expect(() => approveResearchCorpus(db, studyId, { ...approval(), reviewedRights: false })).toThrow("each need your review");
    expect(() => approveResearchCorpus(db, studyId, { ...approval(), sourceRights: [{ ...approval().sourceRights[0], licenseUrl: "javascript:alert(1)" }] })).toThrow("Every source needs");
  });

  it.each(["unknown", "fair_use_excerpt", "link_only"])("checks uncited input dependencies and rejects %s", (rights) => {
    insertCorpusRow(db, "sources", { id: "uncited-source", kind: "commentary_page", title: "Uncited input", dataset_ref: "fixture:uncited", text: "An uncited source informed the research.", content_hash: sha256("An uncited source informed the research."), rights, match_level: "primary_edition", discovered_by: "dataset" });
    insertCorpusRow(db, "run_sources", { run_id: "neutral-run", source_id: "uncited-source", stage: "G5" });
    stamp();
    const inspection = inspectResearchCorpus(db, studyId)!;
    expect(inspection.blockers.map((b) => b.code)).toContain("source_rights");
    expect(inspection.dependencies).toHaveLength(2);
    expect(() => approveResearchCorpus(db, studyId, approval())).toThrow("redistribution");
    expect(db.prepare("SELECT count(*) n FROM research_corpus_packages").get()).toEqual({ n: 0 });
  });

  it("fails closed for legacy briefs and copied research, even with an archive checkbox", () => {
    db.prepare("UPDATE studies SET include_in_archive = 1 WHERE id = ?").run(studyId);
    db.prepare("UPDATE research_runs SET research_scope = 'legacy_private' WHERE id = 'neutral-run'").run();
    expect(inspectResearchCorpus(db, studyId)).toMatchObject({ status: "blocked", preview: null });
    expect(inspectResearchCorpus(db, studyId)!.blockers.map((b) => b.code)).toContain("private_research");
    db.prepare("UPDATE research_runs SET research_scope = 'neutral', brief_json = ? WHERE id = 'neutral-run'").run(JSON.stringify({ reused_from: { study_id: PRIVATE_SENTINEL, run_id: "origin" } }));
    expect(inspectResearchCorpus(db, studyId)).toMatchObject({ status: "blocked", preview: null });
    expect(() => buildResearchCorpusExport(db, studyId)).toThrow("reuses an earlier study");
  });

  it("fails closed for malformed or incomplete research profiles", () => {
    for (const profile of ["null", "[]", "invalid json", '{"pipeline":"neutral-passage@1"}']) {
      db.prepare("UPDATE research_runs SET research_profile_json = ? WHERE id = 'neutral-run'").run(profile);
      expect(inspectResearchCorpus(db, studyId)!.blockers.map((b) => b.code)).toContain("missing_provenance");
      expect(() => approveResearchCorpus(db, studyId, approval())).toThrow("missing a versioned research identity");
    }
  });

  it("invalidates approval when a newer source snapshot changes rights without rewriting the original", () => {
    approveResearchCorpus(db, studyId, approval());
    insertCorpusRow(db, "sources", { id: "new-source-version", kind: "bible_text", title: "Revised rights statement", dataset_ref: `fixture:${PRIVATE_SENTINEL}#snapshot=${sha256("new rights")}`, text: "The LORD's presence distinguishes His people.", content_hash: sha256("The LORD's presence distinguishes His people."), rights: "link_only", match_level: "scripture", discovered_by: "dataset" });
    expect(inspectResearchCorpus(db, studyId)!.blockers.map((b) => b.code)).toContain("source_replaced");
    expect(() => buildResearchCorpusExport(db, studyId)).toThrow("newer version");
    expect(db.prepare("SELECT rights FROM sources WHERE id = 'source-one'").get()).toEqual({ rights: "public_domain" });
  });

  it("rejects stale content hashes and invalidates approval on altered source, artifact, or excerpt data", () => {
    const old = approval();
    db.prepare("UPDATE cards SET body = 'Changed artifact text.' WHERE id = 'artifact-one'").run();
    expect(() => approveResearchCorpus(db, studyId, old)).toThrow("research changed");
    expect(inspectResearchCorpus(db, studyId)!.blockers.map((b) => b.code)).toContain("changed_evidence");
    stamp();
    approveResearchCorpus(db, studyId, approval());
    db.prepare("UPDATE excerpts SET start_offset = 1 WHERE id = 'excerpt-one'").run();
    stamp();
    expect(inspectResearchCorpus(db, studyId)!.blockers.map((b) => b.code)).toContain("excerpt_integrity");
    expect(() => buildResearchCorpusExport(db, studyId)).toThrow();
  });

  it("does not bind corpus approval to private thoughts or selections", () => {
    approveResearchCorpus(db, studyId, approval());
    const hash = inspectResearchCorpus(db, studyId)!.hash;
    db.prepare("UPDATE studies SET note = ?, first_observation = ? WHERE id = ?").run("New private thoughts", "New private observation", studyId);
    db.prepare("UPDATE cards SET selected = 0, dispute_reason = 'private explanation' WHERE id = 'artifact-one'").run();
    expect(inspectResearchCorpus(db, studyId)).toMatchObject({ status: "approved", hash });
    expect(JSON.stringify(buildResearchCorpusExport(db, studyId))).not.toContain("New private");
  });

  it("durably revokes approval on dispute, even if the dispute is subsequently cleared", () => {
    approveResearchCorpus(db, studyId, approval());
    db.prepare("UPDATE cards SET status_interpretation = 'disputed' WHERE id = 'artifact-one'").run();
    expect(inspectResearchCorpus(db, studyId)!.blockers.map((b) => b.code)).toContain("disputed");
    db.prepare("UPDATE cards SET status_interpretation = 'unreviewed' WHERE id = 'artifact-one'").run();
    expect(inspectResearchCorpus(db, studyId)!.status).toBe("revoked");
    expect(() => buildResearchCorpusExport(db, studyId)).toThrow("no current corpus approval");
    expect(db.prepare("SELECT decision FROM research_corpus_decisions ORDER BY rowid").all()).toEqual([{ decision: "approved" }, { decision: "revoked" }]);
  });

  it("durably revokes approval when source rights change and later return", () => {
    approveResearchCorpus(db, studyId, approval());
    db.prepare("UPDATE sources SET rights = 'link_only' WHERE id = 'source-one'").run();
    expect(inspectResearchCorpus(db, studyId)!.status).toBe("blocked");
    db.prepare("UPDATE sources SET rights = 'public_domain' WHERE id = 'source-one'").run();
    expect(inspectResearchCorpus(db, studyId)!.status).toBe("revoked");
    expect(() => buildResearchCorpusExport(db, studyId)).toThrow("no current corpus approval");
  });

  it("records revocation without removing paid research and permits a fresh explicit review", () => {
    approveResearchCorpus(db, studyId, approval());
    const hash = inspectResearchCorpus(db, studyId)!.hash;
    expect(revokeResearchCorpus(db, studyId, { expectedHash: hash }).status).toBe("revoked");
    expect(() => buildResearchCorpusExport(db, studyId)).toThrow();
    expect(db.prepare("SELECT count(*) n FROM research_corpus_packages").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT count(*) n FROM cards").get()).toEqual({ n: 1 });
    expect(approveResearchCorpus(db, studyId, approval()).status).toBe("approved");
  });

  it("inspection and repeated exports make no model calls, ledger charges, or database writes", () => {
    approveResearchCorpus(db, studyId, approval());
    const changes = (db.prepare("SELECT total_changes() n").get() as any).n;
    for (let i = 0; i < 3; i++) {
      inspectResearchCorpus(db, studyId);
      expect(buildResearchCorpusExport(db, studyId)!.manifest.totalCostMicros).toBe(123);
    }
    expect((db.prepare("SELECT total_changes() n").get() as any).n).toBe(changes);
    expect(db.prepare("SELECT sum(usd_micros) total, count(*) n FROM cost_ledger").get()).toEqual({ total: 123, n: 1 });
    expect(db.prepare("SELECT count(*) n FROM llm_calls").get()).toEqual({ n: 1 });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("returns null for a missing study and blocks unresearched studies without exposing their notes", () => {
    expect(inspectResearchCorpus(db, "missing")).toBeNull();
    expect(buildResearchCorpusExport(db, "missing")).toBeNull();
    insertCorpusRow(db, "studies", { id: "empty", primary_ref: "EXO.33.3", display_ref: "Exodus 33:3", ref_start_ord: 2033003, ref_end_ord: 2033003, translation_id: "BSB", origin: "manual", status: "open", note: PRIVATE_SENTINEL, created_local_date: "2026-10-04", created_at: CORPUS_AT, updated_at: CORPUS_AT });
    expect(inspectResearchCorpus(db, "empty")).toMatchObject({ status: "blocked", preview: null });
    expect(JSON.stringify(inspectResearchCorpus(db, "empty"))).not.toContain(PRIVATE_SENTINEL);
  });
});
