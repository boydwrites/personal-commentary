import Database from "better-sqlite3";
import crypto from "node:crypto";
import { DATA_DIR, DB_FILE } from "./config.ts";

export type DB = Database.Database;

export function uuidv7(ms = Date.now()): string {
  const b = crypto.randomBytes(16);
  const ts = BigInt(ms);
  b[0] = Number((ts >> 40n) & 0xffn);
  b[1] = Number((ts >> 32n) & 0xffn);
  b[2] = Number((ts >> 24n) & 0xffn);
  b[3] = Number((ts >> 16n) & 0xffn);
  b[4] = Number((ts >> 8n) & 0xffn);
  b[5] = Number(ts & 0xffn);
  b[6] = (b[6] & 0x0f) | 0x70;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export const nowIso = () => new Date().toISOString();
export function localDate(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
export const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

// Numbered migrations, run in order inside a transaction. Never edit a shipped one; add a new one.
const MIGRATIONS: string[] = [
  /* 001 */ `
CREATE TABLE preferences (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL);

CREATE TABLE authors (
  id TEXT PRIMARY KEY, display_name TEXT NOT NULL, full_identity TEXT NOT NULL,
  tradition TEXT NOT NULL, era_label TEXT,
  hcf_names_json TEXT NOT NULL DEFAULT '[]', sefaria_collective_title TEXT, biblehub_section_title TEXT,
  is_preferred INTEGER NOT NULL DEFAULT 0, preference_rank INTEGER,
  condemned_by_council INTEGER NOT NULL DEFAULT 0, care_note TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE domains (host TEXT PRIMARY KEY, policy TEXT NOT NULL CHECK (policy IN ('primary','context','blocked')), notes TEXT);

CREATE TABLE votd_days (
  local_date TEXT PRIMARY KEY, source TEXT NOT NULL, passage_id TEXT NOT NULL, canonical_ref TEXT NOT NULL, fetched_at TEXT NOT NULL
);

CREATE TABLE studies (
  id TEXT PRIMARY KEY, title TEXT,
  primary_ref TEXT NOT NULL, display_ref TEXT NOT NULL,
  ref_start_ord INTEGER NOT NULL, ref_end_ord INTEGER NOT NULL,
  unit_ref TEXT, unit_label TEXT,
  translation_id TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('votd','continue','series','sunday_text','manual','later')),
  parent_study_id TEXT REFERENCES studies(id),
  status TEXT NOT NULL CHECK (status IN ('open','saved','published','archived')),
  endorsement TEXT NOT NULL DEFAULT 'endorsed' CHECK (endorsement IN ('endorsed','unresolved','revised')),
  question TEXT, first_observation TEXT, note TEXT, note_updated_at TEXT,
  format TEXT NOT NULL DEFAULT 'single',
  include_in_archive INTEGER NOT NULL DEFAULT 0,
  tags_json TEXT NOT NULL DEFAULT '[]',
  created_local_date TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_studies_ords ON studies(ref_start_ord, ref_end_ord);
CREATE INDEX idx_studies_status ON studies(status, updated_at);

CREATE TABLE note_revisions (id TEXT PRIMARY KEY, study_id TEXT NOT NULL REFERENCES studies(id), note TEXT NOT NULL, created_at TEXT NOT NULL);

CREATE TABLE research_runs (
  id TEXT PRIMARY KEY, study_id TEXT NOT NULL REFERENCES studies(id),
  depth TEXT NOT NULL CHECK (depth IN ('standard','deeper')),
  trigger TEXT NOT NULL CHECK (trigger IN ('manual','scheduled')),
  status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','partial','failed','cancelled')),
  stages_json TEXT NOT NULL DEFAULT '{}', prompt_version TEXT NOT NULL,
  context_summary TEXT, qualification TEXT, writer_questions_json TEXT NOT NULL DEFAULT '[]',
  usd_micros INTEGER NOT NULL DEFAULT 0, error TEXT,
  queued_at TEXT NOT NULL, started_at TEXT, finished_at TEXT
);

CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('bible_text','hcf_excerpt','sefaria_text','commentary_page','web_page','lexicon_entry','cross_reference')),
  url TEXT, dataset_ref TEXT UNIQUE,
  title TEXT NOT NULL, author_id TEXT, author_name TEXT, work TEXT, locator TEXT, edition TEXT,
  language TEXT NOT NULL DEFAULT 'en',
  rights TEXT NOT NULL CHECK (rights IN ('public_domain','cc_by','fair_use_excerpt','link_only','unknown')),
  match_level TEXT NOT NULL CHECK (match_level IN ('primary_edition','compiled_excerpt','working_translation','scripture')),
  http_status INTEGER, content_hash TEXT, text TEXT, fetched_at TEXT,
  discovered_by TEXT NOT NULL CHECK (discovered_by IN ('dataset','directory','model_search','manual'))
);

CREATE TABLE run_sources (run_id TEXT NOT NULL REFERENCES research_runs(id), source_id TEXT NOT NULL REFERENCES sources(id), stage TEXT NOT NULL, PRIMARY KEY (run_id, source_id));

CREATE TABLE excerpts (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES research_runs(id), short_id TEXT NOT NULL,
  source_id TEXT NOT NULL REFERENCES sources(id), start_offset INTEGER NOT NULL, end_offset INTEGER NOT NULL,
  text TEXT NOT NULL, refs_json TEXT NOT NULL DEFAULT '[]', UNIQUE (run_id, short_id)
);

CREATE TABLE gaps (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES research_runs(id), author_name TEXT NOT NULL, note TEXT NOT NULL, created_at TEXT NOT NULL);

CREATE TABLE cards (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES research_runs(id), study_id TEXT NOT NULL REFERENCES studies(id),
  type TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, body_model TEXT NOT NULL,
  relationship TEXT NOT NULL, author_id TEXT, author_name TEXT, limitation TEXT, disagreement TEXT,
  priority INTEGER NOT NULL, visible_by_default INTEGER NOT NULL,
  status_source TEXT NOT NULL CHECK (status_source IN ('found','unavailable','not_applicable')),
  status_quote TEXT NOT NULL CHECK (status_quote IN ('none','matched','matched_compiled','working_translation','dequoted')),
  status_interpretation TEXT NOT NULL DEFAULT 'unreviewed' CHECK (status_interpretation IN ('unreviewed','reviewed','disputed')),
  dispute_reason TEXT, flags_json TEXT NOT NULL DEFAULT '[]', selected INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);

CREATE TABLE card_evidence (
  id TEXT PRIMARY KEY, card_id TEXT NOT NULL REFERENCES cards(id), excerpt_id TEXT NOT NULL REFERENCES excerpts(id),
  use TEXT NOT NULL CHECK (use IN ('quote','paraphrase','scripture')), quote_text TEXT,
  match TEXT CHECK (match IN ('exact','loose','elided','not_found')), match_start INTEGER, match_end INTEGER, near_match TEXT
);

CREATE TABLE llm_calls (
  id TEXT PRIMARY KEY, stage TEXT NOT NULL, study_id TEXT, run_id TEXT,
  model TEXT NOT NULL, served_model TEXT, effort TEXT NOT NULL, prompt_version TEXT NOT NULL,
  request_json TEXT, response_json TEXT, stop_reason TEXT, fallback_used INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER,
  web_search_requests INTEGER NOT NULL DEFAULT 0, usd_micros INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER, error TEXT, created_at TEXT NOT NULL
);

CREATE TABLE drafts (
  id TEXT PRIMARY KEY, study_id TEXT NOT NULL REFERENCES studies(id),
  kind TEXT NOT NULL CHECK (kind IN ('edit','alternate','split','manual')),
  format TEXT NOT NULL, parts_json TEXT NOT NULL, hook TEXT, source_reply TEXT,
  changes_json TEXT NOT NULL DEFAULT '[]', claim_map_json TEXT NOT NULL DEFAULT '[]', notes_for_writer TEXT,
  card_ids_json TEXT NOT NULL, note_snapshot TEXT NOT NULL, llm_call_id TEXT, created_at TEXT NOT NULL
);

CREATE TABLE working_texts (
  study_id TEXT PRIMARY KEY REFERENCES studies(id), format TEXT NOT NULL, parts_json TEXT NOT NULL,
  source_reply TEXT, origin_draft_id TEXT, text_hash TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE text_revisions (
  id TEXT PRIMARY KEY, study_id TEXT NOT NULL REFERENCES studies(id), parts_json TEXT NOT NULL, source_reply TEXT,
  text_hash TEXT NOT NULL, cause TEXT NOT NULL, created_at TEXT NOT NULL
);

CREATE TABLE reviews (
  id TEXT PRIMARY KEY, study_id TEXT NOT NULL REFERENCES studies(id), kind TEXT NOT NULL CHECK (kind IN ('deterministic','model')),
  text_hash TEXT NOT NULL, first_line_reading TEXT, overall TEXT, llm_call_id TEXT, created_at TEXT NOT NULL
);

CREATE TABLE findings (
  id TEXT PRIMARY KEY, review_id TEXT NOT NULL REFERENCES reviews(id), check_code TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('blocker','judgment','suggestion')),
  part_index INTEGER, span_text TEXT, problem TEXT NOT NULL, repair TEXT, support_refs_json TEXT NOT NULL DEFAULT '[]',
  resolution TEXT CHECK (resolution IN ('repaired','kept','dismissed','obsolete')), resolution_reason TEXT, resolved_at TEXT
);

-- Decisions on deterministic judgments, keyed by what they flagged (deterministic findings are recomputed on every save).
CREATE TABLE finding_decisions (
  study_id TEXT NOT NULL REFERENCES studies(id), check_code TEXT NOT NULL, span_text TEXT NOT NULL,
  resolution TEXT NOT NULL, reason TEXT, created_at TEXT NOT NULL, PRIMARY KEY (study_id, check_code, span_text)
);

CREATE TABLE posts (
  id TEXT PRIMARY KEY, study_id TEXT NOT NULL REFERENCES studies(id),
  role TEXT NOT NULL CHECK (role IN ('main','thread_part','source_reply','correction')), sequence INTEGER NOT NULL,
  parent_post_id TEXT REFERENCES posts(id), text TEXT NOT NULL, text_hash TEXT NOT NULL, batch_hash TEXT NOT NULL,
  published_text TEXT, text_mismatch INTEGER NOT NULL DEFAULT 0, review_id TEXT,
  channel TEXT NOT NULL CHECK (channel IN ('composer','api')),
  status TEXT NOT NULL CHECK (status IN ('ready','sending','uncertain','posted','failed','deleted','skipped')),
  x_post_id TEXT UNIQUE, x_url TEXT, weighted_length INTEGER NOT NULL, contains_url INTEGER NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0, last_error TEXT, usd_micros INTEGER NOT NULL DEFAULT 0,
  sent_at TEXT, posted_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE later_items (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('card','idea','question','excerpt')),
  card_id TEXT REFERENCES cards(id), study_id TEXT REFERENCES studies(id), text TEXT,
  tags_json TEXT NOT NULL DEFAULT '[]', used_in_study_id TEXT REFERENCES studies(id), created_at TEXT NOT NULL
);

CREATE TABLE corrections (
  id TEXT PRIMARY KEY, study_id TEXT NOT NULL REFERENCES studies(id), what_changed TEXT NOT NULL,
  revised_understanding TEXT NOT NULL, affected_post_ids_json TEXT NOT NULL, created_at TEXT NOT NULL
);

CREATE TABLE activity (
  study_id TEXT NOT NULL REFERENCES studies(id), local_date TEXT NOT NULL,
  active_seconds INTEGER NOT NULL DEFAULT 0, research_wait_seconds INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (study_id, local_date)
);

CREATE TABLE cost_ledger (
  id TEXT PRIMARY KEY, occurred_at TEXT NOT NULL, vendor TEXT NOT NULL CHECK (vendor IN ('anthropic','x')),
  category TEXT NOT NULL, ref_table TEXT, ref_id TEXT, study_id TEXT, run_id TEXT, units INTEGER NOT NULL, usd_micros INTEGER NOT NULL
);

CREATE VIRTUAL TABLE search_index USING fts5(
  entity_type UNINDEXED, entity_id UNINDEXED, study_id UNINDEXED, title, body,
  tokenize = 'porter unicode61 remove_diacritics 2'
);
`,
  /* 002: the readable Markdown record of a study, written on Save and on posting. */ `
ALTER TABLE studies ADD COLUMN record_path TEXT;
ALTER TABLE studies ADD COLUMN saved_at TEXT;
`,
  /* 003: add OpenAI to the ledger while retaining every historical Anthropic charge. */ `
ALTER TABLE cost_ledger RENAME TO cost_ledger_before_openai;
CREATE TABLE cost_ledger (
  id TEXT PRIMARY KEY, occurred_at TEXT NOT NULL, vendor TEXT NOT NULL CHECK (vendor IN ('anthropic','openai','x')),
  category TEXT NOT NULL, ref_table TEXT, ref_id TEXT, study_id TEXT, run_id TEXT, units INTEGER NOT NULL, usd_micros INTEGER NOT NULL
);
INSERT INTO cost_ledger SELECT * FROM cost_ledger_before_openai;
DROP TABLE cost_ledger_before_openai;
`,
  /* 004: where to find preachers and popular commentaries — Bible Hub chapter pages, dedicated gatherers, and searched sites. */ `
ALTER TABLE authors ADD COLUMN biblehub_chapter_slug TEXT;
ALTER TABLE authors ADD COLUMN gatherer TEXT;
ALTER TABLE authors ADD COLUMN web_domains_json TEXT NOT NULL DEFAULT '[]';
`,
  /* 005: the structured study brief (sections, groups, word-study data), draft extras, and the Scripture the user's notes draw on. */ `
ALTER TABLE cards ADD COLUMN section TEXT;
ALTER TABLE cards ADD COLUMN group_label TEXT;
ALTER TABLE cards ADD COLUMN data_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE research_runs ADD COLUMN brief_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE drafts ADD COLUMN extras_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE studies ADD COLUMN allusions_json TEXT;
ALTER TABLE studies ADD COLUMN allusions_hash TEXT;
`,
  /* 006: keep a separate working draft and revision history for every writing format. */ `
CREATE TABLE working_text_variants (
  study_id TEXT NOT NULL REFERENCES studies(id), format TEXT NOT NULL,
  parts_json TEXT NOT NULL, source_reply TEXT, origin_draft_id TEXT,
  text_hash TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (study_id, format)
);
INSERT INTO working_text_variants SELECT study_id, format, parts_json, source_reply, origin_draft_id, text_hash, updated_at FROM working_texts;
ALTER TABLE text_revisions ADD COLUMN format TEXT NOT NULL DEFAULT 'single';
UPDATE text_revisions SET format = COALESCE((SELECT format FROM studies WHERE studies.id = text_revisions.study_id), 'single');
CREATE INDEX idx_text_revisions_format ON text_revisions(study_id, format, created_at);
`,
  /* 007: explicitly separate future neutral research and retain both kinds of private notes. */ `
ALTER TABLE research_runs ADD COLUMN research_scope TEXT NOT NULL DEFAULT 'legacy_private' CHECK (research_scope IN ('legacy_private','neutral'));
ALTER TABLE research_runs ADD COLUMN compatibility_key TEXT;
ALTER TABLE research_runs ADD COLUMN research_profile_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE research_runs ADD COLUMN input_fingerprint TEXT;
CREATE INDEX idx_research_compatibility ON research_runs(research_scope, compatibility_key, status);

-- Historical revisions remain untouched. This baseline records only the current values we actually have.
CREATE TABLE study_note_revisions (
  id TEXT PRIMARY KEY, study_id TEXT NOT NULL REFERENCES studies(id),
  kind TEXT NOT NULL CHECK (kind IN ('initial','reflection')), text TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('baseline','edit')), created_at TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0), UNIQUE (study_id, kind, revision)
);
CREATE INDEX idx_study_note_history ON study_note_revisions(study_id, kind, created_at, id);
INSERT INTO study_note_revisions SELECT lower(hex(randomblob(16))), id, 'initial', first_observation, 'baseline', updated_at, 1 FROM studies WHERE first_observation IS NOT NULL;
INSERT INTO study_note_revisions SELECT lower(hex(randomblob(16))), id, 'reflection', note, 'baseline', updated_at, 1 FROM studies WHERE note IS NOT NULL;
CREATE TRIGGER study_notes_created AFTER INSERT ON studies BEGIN
  INSERT INTO study_note_revisions SELECT lower(hex(randomblob(16))), NEW.id, 'initial', NEW.first_observation, 'edit', NEW.created_at, 1 WHERE NEW.first_observation IS NOT NULL;
  INSERT INTO study_note_revisions SELECT lower(hex(randomblob(16))), NEW.id, 'reflection', NEW.note, 'edit', NEW.created_at, 1 WHERE NEW.note IS NOT NULL;
END;
CREATE TRIGGER study_initial_changed AFTER UPDATE OF first_observation ON studies WHEN NEW.first_observation IS NOT OLD.first_observation BEGIN
  INSERT INTO study_note_revisions SELECT lower(hex(randomblob(16))), NEW.id, 'initial', COALESCE(NEW.first_observation, ''), 'edit', NEW.updated_at, COALESCE(MAX(revision), 0) + 1 FROM study_note_revisions WHERE study_id = NEW.id AND kind = 'initial';
END;
CREATE TRIGGER study_reflection_changed AFTER UPDATE OF note ON studies WHEN NEW.note IS NOT OLD.note BEGIN
  INSERT INTO study_note_revisions SELECT lower(hex(randomblob(16))), NEW.id, 'reflection', COALESCE(NEW.note, ''), 'edit', NEW.updated_at, COALESCE(MAX(revision), 0) + 1 FROM study_note_revisions WHERE study_id = NEW.id AND kind = 'reflection';
END;
CREATE TRIGGER study_notes_immutable_update BEFORE UPDATE ON study_note_revisions BEGIN SELECT RAISE(ABORT, 'Note revisions are immutable'); END;
CREATE TRIGGER study_notes_immutable_delete BEFORE DELETE ON study_note_revisions BEGIN SELECT RAISE(ABORT, 'Note revisions are immutable'); END;
`,
  /* 008: local, hash-bound corpus decisions; never infer permission from study archive choices. */ `
CREATE TABLE research_corpus_decisions (
  id TEXT PRIMARY KEY, study_id TEXT NOT NULL REFERENCES studies(id), content_hash TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('approved','revoked')),
  reviewed_privacy INTEGER NOT NULL DEFAULT 0 CHECK (reviewed_privacy IN (0,1)),
  reviewed_quality INTEGER NOT NULL DEFAULT 0 CHECK (reviewed_quality IN (0,1)),
  reviewed_rights INTEGER NOT NULL DEFAULT 0 CHECK (reviewed_rights IN (0,1)),
  source_rights_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL,
  CHECK (decision != 'approved' OR (reviewed_privacy = 1 AND reviewed_quality = 1 AND reviewed_rights = 1))
);
CREATE INDEX idx_corpus_decisions ON research_corpus_decisions(study_id, content_hash, created_at, id);
CREATE TRIGGER corpus_decision_immutable_update BEFORE UPDATE ON research_corpus_decisions BEGIN SELECT RAISE(ABORT, 'Corpus decisions are immutable'); END;
CREATE TRIGGER corpus_decision_immutable_delete BEFORE DELETE ON research_corpus_decisions BEGIN SELECT RAISE(ABORT, 'Corpus decisions are immutable'); END;
`,
  /* 009: keep approved neutral packages physically separate; disputes revoke approval permanently. */ `
CREATE TABLE research_corpus_packages (
  content_hash TEXT PRIMARY KEY, primary_ref TEXT NOT NULL, translation_id TEXT NOT NULL,
  data_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX idx_corpus_package_passage ON research_corpus_packages(primary_ref, translation_id);
CREATE TRIGGER corpus_package_immutable_update BEFORE UPDATE ON research_corpus_packages BEGIN SELECT RAISE(ABORT, 'Corpus packages are immutable'); END;
CREATE TRIGGER corpus_package_immutable_delete BEFORE DELETE ON research_corpus_packages BEGIN SELECT RAISE(ABORT, 'Corpus packages are immutable'); END;
CREATE TRIGGER corpus_dispute_revokes AFTER UPDATE OF status_interpretation ON cards
WHEN NEW.status_interpretation = 'disputed' AND OLD.status_interpretation != 'disputed' BEGIN
  INSERT INTO research_corpus_decisions (id, study_id, content_hash, decision, created_at)
  SELECT lower(hex(randomblob(16))), study_id, content_hash, 'revoked', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM research_corpus_decisions WHERE rowid = (SELECT MAX(rowid) FROM research_corpus_decisions WHERE study_id = NEW.study_id) AND decision = 'approved';
END;
CREATE TRIGGER corpus_source_change_revokes AFTER UPDATE OF rights, text, content_hash, edition, author_name, work, url ON sources
WHEN NEW.rights IS NOT OLD.rights OR NEW.text IS NOT OLD.text OR NEW.content_hash IS NOT OLD.content_hash
  OR NEW.edition IS NOT OLD.edition OR NEW.author_name IS NOT OLD.author_name OR NEW.work IS NOT OLD.work OR NEW.url IS NOT OLD.url BEGIN
  INSERT INTO research_corpus_decisions (id, study_id, content_hash, decision, created_at)
  SELECT lower(hex(randomblob(16))), d.study_id, d.content_hash, 'revoked', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM research_corpus_decisions d WHERE d.decision = 'approved'
    AND d.rowid = (SELECT MAX(last.rowid) FROM research_corpus_decisions last WHERE last.study_id = d.study_id)
    AND d.study_id IN (
      SELECT r.study_id FROM research_runs r JOIN run_sources rs ON rs.run_id = r.id WHERE rs.source_id = NEW.id
      UNION SELECT c.study_id FROM cards c JOIN card_evidence ce ON ce.card_id = c.id JOIN excerpts e ON e.id = ce.excerpt_id WHERE e.source_id = NEW.id
    );
END;
`,
  /* 010: recheck immutable neutral research evidence before reuse. */ `
ALTER TABLE research_runs ADD COLUMN evidence_fingerprint TEXT;
`,
  /* 011: a title the app chose (from a first draft, or "Choose for me") until you type your own. */ `
ALTER TABLE studies ADD COLUMN title_auto INTEGER NOT NULL DEFAULT 0 CHECK (title_auto IN (0,1));
`,
  /* 012: one notebook. First thoughts join the notes, ahead of what came after the
     research. The triggers from 007 keep both earlier texts in study_note_revisions; updated_at is left alone so the
     Library's order doesn't change. */ `
INSERT INTO note_revisions (id, study_id, note, created_at)
  SELECT lower(hex(randomblob(16))), id,
    CASE WHEN trim(COALESCE(note, '')) = '' THEN rtrim(first_observation, char(10, 13, 32))
         ELSE rtrim(first_observation, char(10, 13, 32)) || char(10, 10) || ltrim(note, char(10, 13, 32)) END,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM studies WHERE trim(COALESCE(first_observation, '')) != '';
UPDATE studies SET
  note = CASE WHEN trim(COALESCE(note, '')) = '' THEN rtrim(first_observation, char(10, 13, 32))
              ELSE rtrim(first_observation, char(10, 13, 32)) || char(10, 10) || ltrim(note, char(10, 13, 32)) END,
  first_observation = NULL
WHERE trim(COALESCE(first_observation, '')) != '';
`,
];

export function openDb(file = DB_FILE): DB {
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  const check = db.pragma("quick_check", { simple: true });
  if (check !== "ok") throw new Error(`The database failed its integrity check (${check}). Restore from a backup in ${DATA_DIR}/backups.`);
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  const applied = new Set(db.prepare("SELECT version FROM schema_migrations").all().map((r: any) => r.version));
  MIGRATIONS.forEach((sql, i) => {
    const v = i + 1;
    if (applied.has(v)) return;
    db.transaction(() => {
      db.exec(sql);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(v, nowIso());
    })();
  });
  return db;
}

export const json = <T>(s: string | null | undefined, fallback: T): T => {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

/** Keeps the full-text index in step with writes (same transaction, no triggers). */
export function indexEntity(db: DB, type: string, id: string, studyId: string, title: string, body: string) {
  db.prepare("DELETE FROM search_index WHERE entity_type = ? AND entity_id = ?").run(type, id);
  db.prepare("INSERT INTO search_index (entity_type, entity_id, study_id, title, body) VALUES (?, ?, ?, ?, ?)").run(type, id, studyId, title ?? "", body ?? "");
}
