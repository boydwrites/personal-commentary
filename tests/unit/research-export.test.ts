import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb, sha256, type DB } from "../../server/db.ts";
import { buildStudyExport } from "../../server/research-export.ts";

let db: DB;
const at = "2026-10-04T12:00:00.000Z";

// Static local fixtures exercise real foreign keys and migrations; no service is called.
function insert(table: string, row: Record<string, unknown>) {
  const columns = Object.keys(row);
  db.prepare(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(...Object.values(row));
}
function study(id: string) {
  insert("studies", { id, primary_ref: "EXO.33.3", display_ref: "Exodus 33:3", ref_start_ord: 2033003, ref_end_ord: 2033003, translation_id: "BSB", origin: "manual", status: "open", first_observation: `${id} initial thoughts`, note: `${id} private notes`, record_path: `/Users/writer/Documents/${id}.md`, created_local_date: "2026-10-04", created_at: at, updated_at: at });
}
function run(id: string, studyId: string, status = "succeeded") {
  insert("research_runs", { id, study_id: studyId, depth: "standard", trigger: "manual", status, prompt_version: "brief-test-v1", queued_at: at, brief_json: '{"unknownFutureField":"preserved"}' });
}
function source(id: string) {
  insert("sources", { id, kind: "commentary_page", dataset_ref: `fixture:${id}`, title: `${id} source`, text: `Evidence stored for ${id}.`, rights: "fair_use_excerpt", match_level: "primary_edition", discovered_by: "dataset" });
}
function card(id: string, runId: string, studyId: string) {
  insert("cards", { id, run_id: runId, study_id: studyId, type: "commentary", title: id, body: "Displayed paraphrase", body_model: 'Original model "quotation"', relationship: "explains", priority: 1, visible_by_default: 1, status_source: "found", status_quote: "dequoted", status_interpretation: "disputed", dispute_reason: "Keep the source in context", selected: 1, created_at: at });
}

beforeEach(() => {
  db = openDb(":memory:");
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Exports must never fetch"); }));
});
afterEach(() => { db.close(); vi.unstubAllGlobals(); });

describe("portable private study export", () => {
  it("preserves all paid attempts, raw evidence, private writing history, and costs without unrelated data", () => {
    study("mine"); study("other");
    run("old", "mine", "partial"); run("new", "mine"); run("failed", "mine", "failed"); run("unrelated", "other");
    source("shared"); source("unrelated");
    insert("run_sources", { run_id: "old", source_id: "shared", stage: "G4" });
    insert("run_sources", { run_id: "new", source_id: "shared", stage: "G4" });
    insert("run_sources", { run_id: "unrelated", source_id: "unrelated", stage: "G4" });
    insert("excerpts", { id: "e1", run_id: "old", short_id: "ex_01", source_id: "shared", start_offset: 0, end_offset: 15, text: "Older evidence.", refs_json: '["EXO.33.3"]' });
    card("old-card", "old", "mine"); card("new-card", "new", "mine"); card("other-card", "unrelated", "other");
    insert("card_evidence", { id: "ev1", card_id: "old-card", excerpt_id: "e1", use: "quote", quote_text: "Older evidence.", match: "exact", match_start: 0, match_end: 15 });
    insert("gaps", { id: "g1", run_id: "failed", author_name: "A missing voice", note: "No direct source found", created_at: at });
    insert("note_revisions", { id: "n1", study_id: "mine", note: "Earlier thoughts", created_at: at });
    insert("working_texts", { study_id: "mine", format: "single", parts_json: '["Editable words"]', text_hash: "current", updated_at: at });
    insert("working_text_variants", { study_id: "mine", format: "journal", parts_json: '["A separate journal entry"]', text_hash: "journal", updated_at: at });
    insert("text_revisions", { id: "t1", study_id: "mine", parts_json: '["Earlier words"]', text_hash: "earlier", cause: "manual", created_at: at });
    insert("drafts", { id: "d1", study_id: "mine", kind: "edit", format: "single", parts_json: '["First draft"]', card_ids_json: '["old-card"]', note_snapshot: "My notes when drafted", created_at: at });
    insert("llm_calls", { id: "c1", study_id: "mine", run_id: "failed", stage: "brief_voices", model: "gpt-6-luna", effort: "medium", prompt_version: "v1", request_json: '{"input":"private mine"}', response_json: '{"status":"incomplete"}', usd_micros: 123, error: "Incomplete", created_at: at });
    insert("llm_calls", { id: "c2", study_id: "other", run_id: "unrelated", stage: "brief_voices", model: "gpt-6-luna", effort: "medium", prompt_version: "v1", request_json: '{"input":"private other"}', created_at: at });
    insert("cost_ledger", { id: "cost1", study_id: "mine", run_id: "failed", occurred_at: at, vendor: "openai", category: "estimated_tokens", units: 0, usd_micros: 123 });
    insert("later_items", { id: "later1", kind: "card", card_id: "old-card", created_at: at });
    insert("preferences", { key: "private-setting", value_json: '"excluded"', updated_at: at });
    const result = buildStudyExport(db, "mine")!;
    expect(result.privacy).toBe("private-study");
    expect(result.data.research_runs.map((r) => r.id).sort()).toEqual(["failed", "new", "old"]);
    expect(result.data.sources).toHaveLength(1);
    expect(result.data.cards).toHaveLength(2);
    expect(result.data.cards.find((c) => c.id === "old-card")).toMatchObject({ selected: 1, status_interpretation: "disputed", body_model: 'Original model "quotation"' });
    expect(result.data.card_evidence[0]).toMatchObject({ match: "exact", match_start: 0, match_end: 15 });
    expect(result.data.llm_calls[0]).toMatchObject({ request_json: '{"input":"private mine"}', response_json: '{"status":"incomplete"}' });
    expect(result.data.cost_ledger[0]).toMatchObject({ usd_micros: 123, category: "estimated_tokens" });
    for (const table of ["gaps", "note_revisions", "working_texts", "working_text_variants", "text_revisions", "drafts", "later_items"]) expect(result.data[table]).toHaveLength(1);
    expect(result.data.studies[0]).not.toHaveProperty("record_path");
    expect(JSON.stringify(result)).not.toContain("private other");
    expect(JSON.stringify(result)).not.toContain("other private notes");
    expect(JSON.stringify(result)).not.toContain("private-setting");
    expect(result.manifest.rowCounts.cards).toBe(2);
    expect(result.manifest.databaseSchemaVersions.length).toBeGreaterThanOrEqual(5);
    expect(result.manifest.dataSha256).toBe(sha256(JSON.stringify(result.data)));
    expect(buildStudyExport(db, "mine")!.manifest.dataSha256).toBe(result.manifest.dataSha256);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("includes donor excerpts for reused cards without exposing the donor's notes or model inputs", () => {
    study("mine"); study("donor");
    run("mine-run", "mine"); run("donor-run", "donor");
    source("donor-source");
    insert("excerpts", { id: "shared-excerpt", run_id: "donor-run", short_id: "ex_01", source_id: "donor-source", start_offset: 2, end_offset: 25, text: "Immutable donor evidence", refs_json: "[]" });
    card("copied-card", "mine-run", "mine");
    insert("card_evidence", { id: "copied-evidence", card_id: "copied-card", excerpt_id: "shared-excerpt", use: "paraphrase" });
    insert("llm_calls", { id: "donor-call", study_id: "donor", run_id: "donor-run", stage: "brief_voices", model: "gpt-6-luna", effort: "medium", prompt_version: "v1", request_json: '{"input":"donor private prompt"}', created_at: at });
    const result = buildStudyExport(db, "mine")!;
    expect(result.data.excerpts[0]).toMatchObject({ id: "shared-excerpt", text: "Immutable donor evidence" });
    expect(result.data.sources[0].id).toBe("donor-source");
    expect(result.manifest.externalResearchRunIds).toEqual(["donor-run"]);
    expect(result.data.research_runs.map((r) => r.id)).toEqual(["mine-run"]);
    expect(result.data.llm_calls).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain("donor private");
  });

  it("returns null for a missing study and exports a study before research starts", () => {
    expect(buildStudyExport(db, "missing")).toBeNull();
    study("mine");
    const result = buildStudyExport(db, "mine")!;
    expect(result.data.studies[0].first_observation).toBe("mine initial thoughts");
    expect(result.data.research_runs).toEqual([]);
    expect(result.manifest.externalResearchRunIds).toEqual([]);
  });

  it("serves a private JSON attachment through the local API, including format variants", async () => {
    const { buildApp } = await import("../../server/index.ts");
    db.close();
    const built = await buildApp(8790, ":memory:");
    db = built.db;
    try {
      study("mine");
      insert("working_text_variants", { study_id: "mine", format: "journal", parts_json: '["Journal kept separately"]', text_hash: "journal-hash", updated_at: at });
      const response = await built.app.inject({ method: "GET", url: "/api/studies/mine/export.json", headers: { host: "127.0.0.1:8790" } });
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers["content-type"]).toContain("application/json");
      expect(response.headers["content-disposition"]).toBe('attachment; filename="Exodus 33-3-study.json"');
      expect(response.json().data.working_text_variants[0]).toMatchObject({ format: "journal", parts_json: '["Journal kept separately"]' });
      const missing = await built.app.inject({ method: "GET", url: "/api/studies/missing/export.json", headers: { host: "127.0.0.1:8790" } });
      expect(missing.statusCode).toBe(404);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    } finally {
      await built.app.close();
    }
  });
});
