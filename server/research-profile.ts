// Neutral research identities. No note, reflection, selection, draft, or personal preference enters this module.
import fs from "node:fs";
import crypto from "node:crypto";
import { DATASET_PATHS, RESEARCH_MODEL } from "./config.ts";
import { sha256, type DB } from "./db.ts";
import { RESEARCH_EDITORIAL_PROFILE, researchSystemPrompt, VERSIONS, CONNECTIONS_SCHEMA, SCRIPTURE_BRIEF_SCHEMA, BACKGROUND_BRIEF_SCHEMA, VOICES_BRIEF_SCHEMA, DISCOVER_SCHEMA } from "./prompts.ts";

export const RESEARCH_PIPELINE_VERSION = "neutral-passage@1";
const datasetHashes = new Map<string, { identity: string; hash: string }>();

/** Hash in bounded chunks, once per observed file version. Dates are cache invalidators, never dataset identities. */
function datasetHash(file: string): string | null {
  let stat: fs.Stats;
  try { stat = fs.statSync(file); } catch { return null; }
  const identity = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  const cached = datasetHashes.get(file);
  if (cached?.identity === identity) return cached.hash;
  const digest = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let n: number;
    while ((n = fs.readSync(fd, buffer, 0, buffer.length, null))) digest.update(buffer.subarray(0, n));
  } finally { fs.closeSync(fd); }
  const hash = digest.digest("hex");
  datasetHashes.set(file, { identity, hash });
  return hash;
}

export function researchIdentity(db: DB, passage: string, translation: string) {
  const authors = db.prepare(`SELECT id, display_name, full_identity, tradition, hcf_names_json, biblehub_section_title,
    is_preferred, preference_rank, condemned_by_council, care_note, sefaria_collective_title, biblehub_chapter_slug, gatherer, web_domains_json
    FROM authors ORDER BY id`).all();
  const profile = {
    pipeline: RESEARCH_PIPELINE_VERSION, editorial: RESEARCH_EDITORIAL_PROFILE,
    language: "en", versification: "bsb@1", retrieval: "gatherers@1", extractor: "source-extractors@1", verifier: "quotation-verifier@1",
    system_sha256: sha256(researchSystemPrompt()),
    calls: {
      connections: { model: RESEARCH_MODEL, effort: "low", prompt: VERSIONS.connections, schema_sha256: sha256(JSON.stringify(CONNECTIONS_SCHEMA)) },
      brief_scripture: { model: RESEARCH_MODEL, effort: "medium", prompt: VERSIONS.brief_scripture, schema_sha256: sha256(JSON.stringify(SCRIPTURE_BRIEF_SCHEMA)) },
      brief_background: { model: RESEARCH_MODEL, effort: "medium", prompt: VERSIONS.brief_background, schema_sha256: sha256(JSON.stringify(BACKGROUND_BRIEF_SCHEMA)) },
      brief_voices: { model: RESEARCH_MODEL, effort: "medium", prompt: VERSIONS.brief_voices, schema_sha256: sha256(JSON.stringify(VOICES_BRIEF_SCHEMA)) },
      discover: { model: RESEARCH_MODEL, effort: "low", prompt: VERSIONS.discover, schema_sha256: sha256(JSON.stringify(DISCOVER_SCHEMA)) },
    },
    datasets: Object.fromEntries(Object.entries(DATASET_PATHS).sort(([a], [b]) => a.localeCompare(b)).map(([name, file]) => [name, datasetHash(file)])),
    authors,
  };
  return { profile, compatibilityKey: sha256(JSON.stringify({ passage, translation, profile })) };
}

/** Exact immutable evidence closure, separate from the pre-retrieval compatibility key. */
export function researchInputFingerprint(db: DB, runId: string, context: unknown): string {
  const sources = db.prepare(`SELECT s.kind, s.dataset_ref, s.url, s.title, s.author_name, s.work, s.locator,
    s.edition, s.language, s.rights, s.match_level, s.content_hash, rs.stage
    FROM run_sources rs JOIN sources s ON s.id = rs.source_id WHERE rs.run_id = ?
    ORDER BY s.dataset_ref, s.content_hash, s.id, rs.stage`).all(runId);
  const excerpts = db.prepare(`SELECT e.short_id, s.content_hash, e.start_offset, e.end_offset, e.text, e.refs_json
    FROM excerpts e JOIN sources s ON s.id = e.source_id WHERE e.run_id = ? ORDER BY e.short_id`).all(runId);
  return sha256(JSON.stringify({ context, sources, excerpts }));
}

/** Recheckable saved result identity; personal selection and interpretation decisions are deliberately separate. */
export function researchEvidenceFingerprint(db: DB, runId: string): string {
  const sources = db.prepare(`SELECT s.id, s.kind, s.dataset_ref, s.url, s.title, s.author_id, s.author_name, s.work, s.locator,
    s.edition, s.language, s.rights, s.match_level, s.content_hash, s.text, s.http_status, s.discovered_by, rs.stage
    FROM run_sources rs JOIN sources s ON s.id = rs.source_id WHERE rs.run_id = ? ORDER BY s.id`).all(runId);
  const excerpts = db.prepare(`SELECT id, short_id, source_id, start_offset, end_offset, text, refs_json FROM excerpts
    WHERE run_id = ? OR id IN (SELECT ce.excerpt_id FROM card_evidence ce JOIN cards c ON c.id = ce.card_id WHERE c.run_id = ?) ORDER BY id`).all(runId, runId);
  const cards = db.prepare(`SELECT id, type, title, body, body_model, relationship, author_id, author_name, limitation, disagreement,
    priority, status_source, status_quote, flags_json, section, group_label, data_json FROM cards WHERE run_id = ? ORDER BY id`).all(runId);
  const evidence = db.prepare(`SELECT e.id, e.card_id, e.excerpt_id, e.use, e.quote_text, e.match, e.match_start, e.match_end, e.near_match
    FROM card_evidence e JOIN cards c ON c.id = e.card_id WHERE c.run_id = ? ORDER BY e.id`).all(runId);
  return sha256(JSON.stringify({ sources, excerpts, cards, evidence }));
}

export function intactResearchEvidence(db: DB, studyId: string, compatibilityKey: string): boolean {
  const runs = db.prepare(`SELECT id, evidence_fingerprint FROM research_runs WHERE study_id = ?
    AND research_scope = 'neutral' AND compatibility_key = ? AND queued_at >= ? AND status IN ('succeeded','partial')
    AND (EXISTS (SELECT 1 FROM cards c WHERE c.run_id = research_runs.id) OR depth = 'deeper')`).all(studyId, compatibilityKey, activeBaseAt(db, studyId)) as any[];
  return runs.length > 0 && runs.every((run) => run.evidence_fingerprint && run.evidence_fingerprint === researchEvidenceFingerprint(db, run.id));
}

function activeBaseAt(db: DB, studyId: string): string {
  return (db.prepare(`SELECT queued_at FROM research_runs r WHERE study_id = ? AND depth = 'standard'
    AND json_extract(brief_json, '$.fill_of') IS NULL AND EXISTS (SELECT 1 FROM cards c WHERE c.run_id = r.id)
    ORDER BY queued_at DESC, id DESC LIMIT 1`).get(studyId) as { queued_at: string } | undefined)?.queued_at ?? "";
}

/** An already observed replacement of any source invalidates automatic reuse, including metadata/rights-only changes. */
export function unchangedResearchSources(db: DB, studyId: string, compatibilityKey: string): boolean {
  const sources = db.prepare(`SELECT DISTINCT s.rowid AS sequence, s.id, s.dataset_ref, s.fetched_at, s.text, s.content_hash
    FROM sources s JOIN run_sources rs ON rs.source_id = s.id JOIN research_runs r ON r.id = rs.run_id
    WHERE r.study_id = ? AND r.research_scope = 'neutral' AND r.compatibility_key = ? AND r.queued_at >= ?`).all(studyId, compatibilityKey, activeBaseAt(db, studyId)) as any[];
  return sources.every((source) => {
    if (!source.dataset_ref || !source.content_hash || !source.fetched_at || source.text == null || sha256(source.text) !== source.content_hash) return false;
    const origin = source.dataset_ref.split("#snapshot=")[0];
    const newer = db.prepare(`SELECT 1 FROM sources WHERE id != ? AND
      (dataset_ref = ? OR substr(dataset_ref, 1, ?) = ?) AND rowid > ? LIMIT 1`)
      .get(source.id, origin, `${origin}#snapshot=`.length, `${origin}#snapshot=`, source.sequence);
    return !newer;
  });
}
