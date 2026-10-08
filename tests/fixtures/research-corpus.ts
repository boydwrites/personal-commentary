import { sha256, type DB } from "../../server/db.ts";
import { researchEvidenceFingerprint } from "../../server/research-profile.ts";

export const CORPUS_AT = "2026-10-04T12:00:00.000Z";
export const PRIVATE_SENTINEL = "PRIVATE_SENTINEL_never_in_corpus";

export function insertCorpusRow(db: DB, table: string, row: Record<string, unknown>) {
  const columns = Object.keys(row);
  db.prepare(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(...Object.values(row));
}

/** Synthetic, offline-only research and private writing fixture. No services or installed datasets. */
export function seedResearchCorpus(db: DB, studyId = "private-study", scope = "neutral") {
  const insert = (table: string, row: Record<string, unknown>) => insertCorpusRow(db, table, row);
  insert("studies", { id: studyId, primary_ref: "EXO.33.3", display_ref: "Exodus 33:3", ref_start_ord: 2033003, ref_end_ord: 2033003, translation_id: "BSB", origin: "manual", status: "open", title: PRIVATE_SENTINEL, question: PRIVATE_SENTINEL,
    first_observation: PRIVATE_SENTINEL, note: PRIVATE_SENTINEL, created_local_date: "2026-10-04", created_at: CORPUS_AT, updated_at: CORPUS_AT });
  const profile = { pipeline: "neutral-passage@1", editorial: "scripture-first-creedal@1", language: "en", versification: "bsb@1", retrieval: "gatherers@1", extractor: "source-extractors@1", verifier: "quotation-verifier@1", system_sha256: sha256("system"),
    calls: Object.fromEntries(["connections", "brief_scripture", "brief_background", "brief_voices", "discover"].map((stage) => [stage, { model: "gpt-6-luna", effort: "medium", prompt: `${stage}@1`, schema_sha256: sha256(stage) }])),
    datasets: { bsb: sha256("BSB fixture") }, arbitrary: PRIVATE_SENTINEL, authors: [{ care_note: PRIVATE_SENTINEL }] };
  insert("research_runs", { id: "neutral-run", study_id: studyId, depth: "standard", trigger: "manual", status: "succeeded", prompt_version: "fixture@1", research_scope: scope, compatibility_key: sha256("key"), input_fingerprint: sha256("input"), research_profile_json: JSON.stringify(profile),
    context_summary: "Moses pleads for the Lord's presence.", qualification: "Read the promise in its covenant setting.", brief_json: JSON.stringify({ unknown: PRIVATE_SENTINEL }), writer_questions_json: JSON.stringify([PRIVATE_SENTINEL]), usd_micros: 123, queued_at: CORPUS_AT, started_at: CORPUS_AT, finished_at: CORPUS_AT });
  const sourceText = "The LORD's presence distinguishes His people.";
  insert("sources", { id: "source-one", kind: "bible_text", url: "https://example.org/source", dataset_ref: `fixture:${PRIVATE_SENTINEL}`, title: "Exodus 33 source fixture", author_name: "Source author", text: sourceText, content_hash: sha256(sourceText), rights: "public_domain", match_level: "scripture", discovered_by: "dataset", fetched_at: CORPUS_AT });
  insert("run_sources", { run_id: "neutral-run", source_id: "source-one", stage: "P" });
  insert("excerpts", { id: "excerpt-one", run_id: "neutral-run", short_id: "E1", source_id: "source-one", start_offset: 0, end_offset: sourceText.length, text: sourceText, refs_json: JSON.stringify({ unknown: PRIVATE_SENTINEL }) });
  insert("cards", { id: "artifact-one", run_id: "neutral-run", study_id: studyId, type: "context", title: "The Lord's presence matters", body: "Moses seeks the Lord's presence with His people.", body_model: "Moses seeks the Lord's presence with His people.", relationship: "editor_synthesis", section: "scripture", priority: 1, visible_by_default: 1, status_source: "found", status_quote: "none", selected: 1,
    dispute_reason: PRIVATE_SENTINEL, flags_json: JSON.stringify([PRIVATE_SENTINEL]), data_json: JSON.stringify({ unknown: PRIVATE_SENTINEL, reused_from: { study_id: PRIVATE_SENTINEL } }), created_at: CORPUS_AT });
  insert("card_evidence", { id: "evidence-one", card_id: "artifact-one", excerpt_id: "excerpt-one", use: "paraphrase", near_match: PRIVATE_SENTINEL });
  insert("llm_calls", { id: "call-one", study_id: studyId, run_id: "neutral-run", stage: "brief_scripture", model: "gpt-6-luna", served_model: "gpt-6-luna", effort: "medium", prompt_version: "fixture@1", request_json: JSON.stringify({ private: PRIVATE_SENTINEL }), response_json: JSON.stringify({ private: PRIVATE_SENTINEL }), stop_reason: "completed", error: PRIVATE_SENTINEL, usd_micros: 123, input_tokens: 100, output_tokens: 50, created_at: CORPUS_AT });
  insert("cost_ledger", { id: "cost-one", study_id: studyId, run_id: "neutral-run", occurred_at: CORPUS_AT, vendor: "openai", category: "tokens", ref_table: "llm_calls", ref_id: "call-one", units: 150, usd_micros: 123 });
  insert("drafts", { id: "draft-one", study_id: studyId, kind: "edit", format: "journal", parts_json: JSON.stringify([PRIVATE_SENTINEL]), card_ids_json: '["artifact-one"]', note_snapshot: PRIVATE_SENTINEL, created_at: CORPUS_AT });
  insert("reviews", { id: "review-one", study_id: studyId, kind: "model", text_hash: sha256(PRIVATE_SENTINEL), overall: PRIVATE_SENTINEL, created_at: CORPUS_AT });
  insert("preferences", { key: "theologicalFrame", value_json: JSON.stringify(PRIVATE_SENTINEL), updated_at: CORPUS_AT });
  db.prepare("UPDATE research_runs SET evidence_fingerprint = ? WHERE id = 'neutral-run'").run(researchEvidenceFingerprint(db, "neutral-run"));
}
