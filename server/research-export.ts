// A portable private study archive. It preserves persisted rows, including older/partial research,
// instead of flattening the evidence into the readable Markdown record.
import type { DB } from "./db.ts";
import { nowIso, sha256 } from "./db.ts";

type ExportRow = Record<string, string | number | null>;

export interface StudyExport {
  format: "personal-commentary.study-export";
  version: 1;
  exportedAt: string;
  privacy: "private-study";
  manifest: {
    databaseSchemaVersions: number[];
    rowCounts: Record<string, number>;
    dataSha256: string;
    hashEncoding: "sha256(JSON.stringify(data)), UTF-8";
    externalResearchRunIds: string[];
    excluded: string[];
    limitations: string[];
  };
  data: Record<string, ExportRow[]>;
}

/**
 * Reads one consistent snapshot without network, model calls, or writes. JSON columns remain strings
 * so legacy/unknown fields and even malformed stored JSON survive. Export is private backup material:
 * the selected study's notes and model inputs, and source text with differing rights, are included.
 * A missing study returns null. This is an export format, not a restore implementation.
 */
export function buildStudyExport(db: DB, studyId: string): StudyExport | null {
  return db.transaction((): StudyExport | null => {
    const study = db.prepare("SELECT * FROM studies WHERE id = ?").get(studyId) as ExportRow | undefined;
    if (!study) return null;
    // Local filesystem paths are neither portable nor needed to reconstruct the study.
    const { record_path: _recordPath, ...portableStudy } = study;
    const rows = (sql: string) => db.prepare(sql).all({ studyId }) as ExportRow[];
    const ownRuns = "SELECT id FROM research_runs WHERE study_id = :studyId";
    const ownCards = "SELECT id FROM cards WHERE study_id = :studyId";
    // Reused research retains donor excerpt IDs. Include their saved evidence text, without exporting
    // the donor study or its model inputs (which can contain that writer's private thoughts).
    const neededExcerpts = `SELECT id FROM excerpts WHERE run_id IN (${ownRuns})
      OR id IN (SELECT excerpt_id FROM card_evidence WHERE card_id IN (${ownCards}))`;
    const neededSources = `SELECT source_id FROM run_sources WHERE run_id IN (${ownRuns})
      UNION SELECT source_id FROM excerpts WHERE id IN (${neededExcerpts})`;
    const ownCalls = `SELECT id FROM llm_calls WHERE study_id = :studyId
      OR (study_id IS NULL AND run_id IN (${ownRuns}))`;
    const data: Record<string, ExportRow[]> = {
      studies: [portableStudy],
      research_runs: rows("SELECT * FROM research_runs WHERE study_id = :studyId ORDER BY queued_at, id"),
      run_sources: rows(`SELECT * FROM run_sources WHERE run_id IN (${ownRuns}) ORDER BY run_id, source_id`),
      sources: rows(`SELECT * FROM sources WHERE id IN (${neededSources}) ORDER BY id`),
      authors: rows(`SELECT * FROM authors WHERE id IN (
        SELECT author_id FROM sources WHERE id IN (${neededSources})
        UNION SELECT author_id FROM cards WHERE study_id = :studyId
      ) ORDER BY id`),
      excerpts: rows(`SELECT * FROM excerpts WHERE id IN (${neededExcerpts}) ORDER BY run_id, short_id, id`),
      gaps: rows(`SELECT * FROM gaps WHERE run_id IN (${ownRuns}) ORDER BY created_at, id`),
      cards: rows("SELECT * FROM cards WHERE study_id = :studyId ORDER BY created_at, id"),
      card_evidence: rows(`SELECT * FROM card_evidence WHERE card_id IN (${ownCards}) ORDER BY card_id, id`),
      llm_calls: rows(`SELECT * FROM llm_calls WHERE id IN (${ownCalls}) ORDER BY created_at, id`),
      cost_ledger: rows(`SELECT * FROM cost_ledger WHERE study_id = :studyId
        OR (study_id IS NULL AND (run_id IN (${ownRuns}) OR (ref_table = 'llm_calls' AND ref_id IN (${ownCalls}))))
        ORDER BY occurred_at, id`),
      note_revisions: rows("SELECT * FROM note_revisions WHERE study_id = :studyId ORDER BY created_at, id"),
      study_note_revisions: rows("SELECT * FROM study_note_revisions WHERE study_id = :studyId ORDER BY kind, revision"),
      research_corpus_decisions: rows("SELECT * FROM research_corpus_decisions WHERE study_id = :studyId ORDER BY created_at, id"),
      research_corpus_packages: rows("SELECT * FROM research_corpus_packages WHERE content_hash IN (SELECT content_hash FROM research_corpus_decisions WHERE study_id = :studyId) ORDER BY created_at, content_hash"),
      drafts: rows("SELECT * FROM drafts WHERE study_id = :studyId ORDER BY created_at, id"),
      working_texts: rows("SELECT * FROM working_texts WHERE study_id = :studyId ORDER BY format"),
      working_text_variants: rows("SELECT * FROM working_text_variants WHERE study_id = :studyId ORDER BY format"),
      text_revisions: rows("SELECT * FROM text_revisions WHERE study_id = :studyId ORDER BY created_at, id"),
      reviews: rows("SELECT * FROM reviews WHERE study_id = :studyId ORDER BY created_at, id"),
      findings: rows("SELECT * FROM findings WHERE review_id IN (SELECT id FROM reviews WHERE study_id = :studyId) ORDER BY review_id, id"),
      finding_decisions: rows("SELECT * FROM finding_decisions WHERE study_id = :studyId ORDER BY check_code, span_text"),
      posts: rows("SELECT * FROM posts WHERE study_id = :studyId ORDER BY created_at, sequence, id"),
      later_items: rows(`SELECT * FROM later_items WHERE study_id = :studyId
        OR (study_id IS NULL AND card_id IN (${ownCards})) ORDER BY created_at, id`),
      corrections: rows("SELECT * FROM corrections WHERE study_id = :studyId ORDER BY created_at, id"),
      activity: rows("SELECT * FROM activity WHERE study_id = :studyId ORDER BY local_date"),
    };
    const includedRunIds = new Set(data.research_runs.map((r) => r.id));
    const externalResearchRunIds = [...new Set(data.excerpts.map((e) => String(e.run_id)).filter((id) => !includedRunIds.has(id)))].sort();
    return {
      format: "personal-commentary.study-export",
      version: 1,
      exportedAt: nowIso(),
      privacy: "private-study",
      manifest: {
        databaseSchemaVersions: (db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as { version: number }[]).map((r) => r.version),
        rowCounts: Object.fromEntries(Object.entries(data).map(([table, values]) => [table, values.length])),
        dataSha256: sha256(JSON.stringify(data)),
        hashEncoding: "sha256(JSON.stringify(data)), UTF-8",
        externalResearchRunIds,
        excluded: ["Credentials and preferences", "Other studies and their private model inputs", "Local record paths", "HTTP cache, logs, and downloaded dataset files", "Rebuildable search indexes"],
        limitations: [
          "Private backup material: includes this study's notes and model inputs. Source rights are preserved, not cleared for redistribution.",
          "Includes stored source snapshots. Historical versions overwritten before source versioning cannot be recovered; saved excerpts preserve card evidence.",
          "Reused evidence can refer to external research run IDs. Donor study records, model inputs, and original costs are not included.",
          "Related study IDs are lineage references only. This file does not implement restoration or cloud sync.",
        ],
      },
      data,
    };
  })();
}
