// Local curation only. This module has no network or model dependencies and never uploads anything.
import { json, nowIso, sha256, uuidv7, type DB } from "./db.ts";
import { HttpError } from "./errors.ts";
import { researchEvidenceFingerprint } from "./research-profile.ts";
import type { ResearchCorpusApproval, ResearchCorpusData, ResearchCorpusExport, ResearchCorpusInspection, ResearchSourceRights } from "../shared/research.ts";

type Row = Record<string, any>;
const HASH = /^[a-f0-9]{64}$/;
const RESEARCH_STAGES = ["connections", "brief_scripture", "brief_background", "brief_voices", "discover"];
const DATASETS = ["bsb", "hcf", "openbible", "stepbible"];
const text = (value: unknown): string => typeof value === "string" ? value : "";
const validHash = (value: unknown): value is string => typeof value === "string" && HASH.test(value);
const eligibleRights = (rights: string) => rights === "public_domain" || rights === "cc_by";
const object = (raw: string): Row => {
  const value = json<unknown>(raw, {});
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
};

function cleanProfile(raw: string): ResearchCorpusData["runs"][number]["profile"] {
  const p = object(raw);
  return {
    editorial: text(p.editorial), language: text(p.language), versification: text(p.versification), retrieval: text(p.retrieval),
    extractor: text(p.extractor), verifier: text(p.verifier), systemSha256: validHash(p.system_sha256) ? p.system_sha256 : "",
    calls: RESEARCH_STAGES.flatMap((stage) => {
      const c = p.calls?.[stage];
      return c && typeof c === "object" ? [{ stage, model: text(c.model), effort: text(c.effort), promptVersion: text(c.prompt), schemaSha256: validHash(c.schema_sha256) ? c.schema_sha256 : "" }] : [];
    }),
    datasets: DATASETS.map((name) => ({ name, sha256: validHash(p.datasets?.[name]) ? p.datasets[name] : null })),
    authors: (Array.isArray(p.authors) ? p.authors : []).filter((a: Row) => a && typeof a.display_name === "string").map((a: Row) => ({ name: a.display_name, identity: text(a.full_identity), tradition: text(a.tradition), preferred: a.is_preferred === 1, rank: typeof a.preference_rank === "number" ? a.preference_rank : null })),
  };
}

function wordData(raw: string): ResearchCorpusData["artifacts"][number]["word"] {
  const w = object(raw);
  if (typeof w.strong !== "string" || !/^[HG]\d{4}[A-Z]?$/i.test(w.strong)) return null;
  return { strong: w.strong, lemma: text(w.lemma), transliteration: text(w.translit), gloss: text(w.gloss), partOfSpeech: text(w.pos), definition: text(w.definition), language: text(w.language), occurrenceCount: typeof w.count === "number" ? w.count : 0,
    uses: (Array.isArray(w.uses) ? w.uses : []).filter((u: Row) => u && typeof u.ref === "string" && typeof u.text === "string").map((u: Row) => ({ ref: u.ref, text: u.text })) };
}

function briefProse(raw: string) {
  const b = object(raw);
  return { where: b.where && typeof b.where === "object" ? { book: text(b.where.book), section: text(b.where.section), flow: text(b.where.flow), thisVerse: text(b.where.this_verse) } : null,
    christSummary: typeof b.christ_summary === "string" ? b.christ_summary : null };
}

/** Read decisions by insertion order: ISO timestamps can tie, including a revoke immediately after approval. */
function latestDecision(db: DB, studyId: string): Row | undefined {
  return db.prepare("SELECT * FROM research_corpus_decisions WHERE study_id = ? ORDER BY rowid DESC LIMIT 1").get(studyId) as Row | undefined;
}

function inspect(db: DB, studyId: string): ResearchCorpusInspection | null {
  const study = db.prepare("SELECT primary_ref, display_ref, ref_start_ord, ref_end_ord, translation_id FROM studies WHERE id = ?").get(studyId) as Row | undefined;
  if (!study) return null;
  const allRuns = db.prepare("SELECT * FROM research_runs WHERE study_id = ? ORDER BY queued_at, id").all(studyId) as Row[];
  const allCards = db.prepare("SELECT * FROM cards WHERE study_id = ? ORDER BY created_at, id").all(studyId) as Row[];
  const base = allRuns.filter((r) => r.depth === "standard" && !object(r.brief_json).fill_of && allCards.some((c) => c.run_id === r.id)).at(-1);
  const selectedRuns = base ? allRuns.filter((r) => r.id === base.id || object(r.brief_json).fill_of === base.id || (r.depth === "deeper" && r.queued_at >= base.queued_at)) : [];
  const blockers: ResearchCorpusInspection["blockers"] = [];
  const block = (code: string, message: string) => { if (!blockers.some((b) => b.code === code)) blockers.push({ code, message }); };
  if (!base) block("no_research", "No completed passage brief is available. Your study is saved; research the passage before preparing a corpus copy.");
  if (selectedRuns.some((r) => r.research_scope !== "neutral")) block("private_research", "This brief may contain personal context from earlier research. Your private study stays available; prepare a new neutral brief before corpus review.");
  if (allRuns.some((r) => r.status === "queued" || r.status === "running")) block("running", "Research is still in progress. Your saved study remains available; wait for research to finish before reviewing its corpus copy.");
  if (selectedRuns.some((r) => !["succeeded", "partial"].includes(r.status))) block("incomplete_run", "The current brief includes an unfinished attempt. Its saved findings remain private; finish or refresh the brief before corpus review.");
  if (selectedRuns.some((r) => object(r.brief_json).reused_from)) block("reused_research", "This brief reuses an earlier study. Its provenance stays private here; review the original neutral brief for a corpus copy.");
  if (selectedRuns.some((r) => {
    const p = cleanProfile(r.research_profile_json);
    return !validHash(r.compatibility_key) || !validHash(r.input_fingerprint) || !text(object(r.research_profile_json).pipeline) || !p.editorial || !p.language || !p.versification || !p.retrieval || !p.extractor || !p.verifier || !p.systemSha256 || p.calls.length !== RESEARCH_STAGES.length || p.calls.some((c) => !c.model || !c.promptVersion || !c.schemaSha256 || !c.effort);
  })) block("missing_provenance", "This brief is missing a versioned research identity. Your findings remain saved; prepare a new neutral brief before corpus review.");
  if (selectedRuns.some((r) => !validHash(r.evidence_fingerprint) || r.evidence_fingerprint !== researchEvidenceFingerprint(db, r.id))) block("changed_evidence", "Research evidence or its provenance changed after the brief was prepared. Your private study is saved; prepare a new neutral brief before corpus review.");
  if (selectedRuns.some((r) => r.compatibility_key !== base?.compatibility_key)) block("incompatible_runs", "The brief combines different research versions. Your saved findings remain available; prepare a new neutral brief before corpus review.");

  const decision = latestDecision(db, studyId);
  let preview: ResearchCorpusData | null = null;
  let guard: unknown = selectedRuns.map((r) => ({ id: r.id, scope: r.research_scope, status: r.status }));
  // Legacy/personalized prose is deliberately not offered as an apparently anonymized preview.
  if (base && !blockers.some((b) => ["private_research", "reused_research"].includes(b.code))) {
    const ids = selectedRuns.map((r) => r.id as string);
    const slots = ids.map(() => "?").join(",");
    const cards = allCards.filter((c) => ids.includes(c.run_id));
    const evidence = db.prepare(`SELECT ce.* FROM card_evidence ce JOIN cards c ON c.id = ce.card_id WHERE c.run_id IN (${slots}) ORDER BY ce.card_id, ce.id`).all(...ids) as Row[];
    const excerpts = db.prepare(`SELECT * FROM excerpts WHERE run_id IN (${slots}) OR id IN (SELECT ce.excerpt_id FROM card_evidence ce JOIN cards c ON c.id = ce.card_id WHERE c.run_id IN (${slots})) ORDER BY run_id, id`).all(...ids, ...ids) as Row[];
    const runSources = db.prepare(`SELECT * FROM run_sources WHERE run_id IN (${slots}) ORDER BY run_id, source_id`).all(...ids) as Row[];
    const sourceIds = [...new Set([...runSources.map((r) => r.source_id), ...excerpts.map((e) => e.source_id)])].sort();
    const sources = sourceIds.length ? db.prepare(`SELECT rowid AS sequence, * FROM sources WHERE id IN (${sourceIds.map(() => "?").join(",")}) ORDER BY id`).all(...sourceIds) as Row[] : [];
    const calls = db.prepare(`SELECT * FROM llm_calls WHERE run_id IN (${slots}) ORDER BY created_at, id`).all(...ids) as Row[];
    const costs = db.prepare(`SELECT * FROM cost_ledger WHERE run_id IN (${slots}) ORDER BY occurred_at, id`).all(...ids) as Row[];
    const gaps = db.prepare(`SELECT run_id, author_name, note FROM gaps WHERE run_id IN (${slots}) ORDER BY run_id, created_at, id`).all(...ids) as Row[];
    if (cards.some((c) => c.status_interpretation === "disputed")) block("disputed", "A finding in this brief is disputed. Your study is saved; resolve or refresh the finding before corpus review.");
    if (excerpts.some((e) => !ids.includes(e.run_id))) block("external_evidence", "The brief depends on evidence from another research run. Your private evidence stays available; review the original neutral brief before export.");
    if (!sources.length) block("missing_sources", "This brief has no retained source snapshots. It remains saved privately; refresh research to preserve its evidence before corpus review.");
    if (sources.some((s) => !eligibleRights(s.rights))) block("source_rights", "A source permits no confirmed redistribution. Private research still works; this entire brief stays ineligible until every input source has supported redistribution rights.");
    if (sources.some((s) => typeof s.text !== "string" || !s.content_hash || sha256(s.text) !== s.content_hash)) block("source_integrity", "A source snapshot is missing or has changed. Your study remains saved; refresh research with intact snapshots before corpus review.");
    if (sources.some((s) => {
      if (!s.dataset_ref) return false;
      const origin = s.dataset_ref.split("#snapshot=")[0];
      const prefix = `${origin}#snapshot=`;
      return !!db.prepare("SELECT 1 FROM sources WHERE id != ? AND (dataset_ref = ? OR substr(dataset_ref, 1, ?) = ?) AND rowid > ? LIMIT 1").get(s.id, origin, prefix.length, prefix, s.sequence);
    })) block("source_replaced", "A newer version of an input source has been saved. Your earlier research remains private and intact; refresh the brief before corpus review.");
    if (excerpts.some((e) => !Number.isInteger(e.start_offset) || !Number.isInteger(e.end_offset) || e.start_offset < 0 || e.end_offset < e.start_offset || sources.find((s) => s.id === e.source_id)?.text?.slice(e.start_offset, e.end_offset) !== e.text)) block("excerpt_integrity", "An excerpt does not match its source snapshot and stored offsets. Your private study stays saved; refresh research with intact evidence before corpus review.");
    if (calls.some((c) => !RESEARCH_STAGES.includes(c.stage))) block("private_call", "The brief contains a model call outside neutral research. Your study stays available privately; prepare a new neutral brief before corpus review.");
    if (selectedRuns.some((r) => !calls.some((c) => c.run_id === r.id))) block("missing_calls", "A research run has no retained model provenance. Its findings remain saved; prepare a new neutral brief before corpus review.");
    if (costs.some((c) => !["tokens", "estimated_tokens"].includes(c.category) || c.ref_table !== "llm_calls" || !calls.some((call) => call.id === c.ref_id))) block("cost_provenance", "A research charge has incomplete provenance. Your study and cost records remain saved; repair the local provenance before corpus review.");
    preview = {
      passage: { canonicalRef: study.primary_ref, displayRef: study.display_ref, startOrdinal: study.ref_start_ord, endOrdinal: study.ref_end_ord, translationId: study.translation_id },
      runs: selectedRuns.map((r) => ({ id: r.id, depth: r.depth, status: r.status, promptVersion: r.prompt_version, compatibilityKey: r.compatibility_key, inputFingerprint: r.input_fingerprint,
        profileVersion: text(object(r.research_profile_json).pipeline), profile: cleanProfile(r.research_profile_json), startedAt: r.started_at, finishedAt: r.finished_at, contextSummary: r.context_summary, qualification: r.qualification, ...briefProse(r.brief_json) })),
      artifacts: cards.map((c) => ({ id: c.id, runId: c.run_id, kind: c.type, section: c.section, group: c.group_label, title: c.title, displayBody: c.body, modelBody: c.body_model,
        contentSha256: sha256(JSON.stringify({ title: c.title, displayBody: c.body, modelBody: c.body_model })), relationship: c.relationship, authorName: c.author_name, limitation: c.limitation, disagreement: c.disagreement, sourceStatus: c.status_source, quotationStatus: c.status_quote, word: wordData(c.data_json) })),
      sources: sources.map((s) => ({ id: s.id, kind: s.kind, url: s.url, title: s.title, authorName: s.author_name, work: s.work, locator: s.locator, edition: s.edition, language: s.language, rights: s.rights, matchLevel: s.match_level, text: s.text, contentSha256: s.content_hash, fetchedAt: s.fetched_at })),
      runSources: runSources.map((r) => ({ runId: r.run_id, sourceId: r.source_id, stage: r.stage })),
      gaps: gaps.map((g) => ({ runId: g.run_id, authorName: g.author_name, note: g.note })),
      excerpts: excerpts.map((e) => ({ id: e.id, runId: e.run_id, sourceId: e.source_id, text: e.text, contentSha256: sha256(e.text), startOffset: e.start_offset, endOffset: e.end_offset, offsetEncoding: "UTF-16" })),
      evidence: evidence.map((e) => ({ id: e.id, artifactId: e.card_id, excerptId: e.excerpt_id, use: e.use, quoteText: e.quote_text, match: e.match, matchStart: e.match_start, matchEnd: e.match_end, offsetEncoding: "UTF-16" })),
      modelCalls: calls.filter((c) => RESEARCH_STAGES.includes(c.stage)).map((c) => ({ id: c.id, runId: c.run_id, stage: c.stage, requestedModel: c.model, servedModel: c.served_model, effort: c.effort, promptVersion: c.prompt_version,
        outcome: c.stop_reason === "completed" ? "completed" : "incomplete", inputTokens: c.input_tokens, outputTokens: c.output_tokens, cacheReadTokens: c.cache_read_tokens, cacheWriteTokens: c.cache_write_tokens, webSearchRequests: c.web_search_requests, latencyMs: c.latency_ms, createdAt: c.created_at })),
      costEvents: costs.filter((c) => ["tokens", "estimated_tokens"].includes(c.category) && c.ref_table === "llm_calls" && calls.some((call) => call.id === c.ref_id)).map((c) => ({ id: c.id, runId: c.run_id, modelCallId: c.ref_id, occurredAt: c.occurred_at, vendor: c.vendor, category: c.category, units: c.units, usdMicros: c.usd_micros, estimated: c.category === "estimated_tokens" })),
    };
    guard = { runs: selectedRuns.map((r) => ({ id: r.id, scope: r.research_scope, status: r.status })), disputes: cards.filter((c) => c.status_interpretation === "disputed").map((c) => c.id) };
  }
  const hash = sha256(JSON.stringify({ version: 1, data: preview, guard, blockers: blockers.map((b) => b.code) }));
  const currentDecision = decision?.content_hash === hash ? decision : undefined;
  const savedPackage = currentDecision?.decision === "approved" ? db.prepare("SELECT data_json FROM research_corpus_packages WHERE content_hash = ?").get(hash) as { data_json: string } | undefined : undefined;
  const approved = currentDecision?.decision === "approved" && !!savedPackage && savedPackage.data_json === JSON.stringify(preview);
  const rights = currentDecision ? json<ResearchSourceRights[]>(currentDecision.source_rights_json, []) : [];
  return {
    hash, status: blockers.length ? "blocked" : approved ? "approved" : currentDecision?.decision === "revoked" ? "revoked" : "needs_review", blockers,
    counts: { runs: preview?.runs.length ?? 0, artifacts: preview?.artifacts.length ?? 0, sources: preview?.sources.length ?? 0, excerpts: preview?.excerpts.length ?? 0, evidence: preview?.evidence.length ?? 0, modelCalls: preview?.modelCalls.length ?? 0, costEvents: preview?.costEvents.length ?? 0 },
    preview, dependencies: (preview?.sources ?? []).map((s) => ({ sourceId: s.id, title: s.title, rights: s.rights, eligible: eligibleRights(s.rights), licenseUrl: rights.find((r) => r.sourceId === s.id)?.licenseUrl ?? null,
      attribution: rights.find((r) => r.sourceId === s.id)?.attribution ?? null, provenanceUrl: rights.find((r) => r.sourceId === s.id)?.provenanceUrl ?? null })),
    review: decision ? { id: decision.id, decision: decision.decision, createdAt: decision.created_at } : null, cloudSyncEnabled: false,
  };
}

export function inspectResearchCorpus(db: DB, studyId: string): ResearchCorpusInspection | null {
  return db.transaction(() => inspect(db, studyId))();
}

function checkedInspection(db: DB, studyId: string, expectedHash?: string): ResearchCorpusInspection {
  const result = inspect(db, studyId);
  if (!result) throw new HttpError(404, "This study could not be found. Other studies remain available; return to the library.");
  if (expectedHash !== undefined && result.hash !== expectedHash) throw new HttpError(409, "The research changed after you opened it. Your study is saved; inspect the current corpus copy before deciding.");
  return result;
}

function sourceRights(input: ResearchSourceRights[], inspection: ResearchCorpusInspection): ResearchSourceRights[] {
  const https = (s: unknown) => { try { const u = new URL(text(s)); return u.protocol === "https:" && !u.username && !u.password; } catch { return false; } };
  if (!Array.isArray(input) || input.length !== inspection.dependencies.length || new Set(input.map((r) => r?.sourceId)).size !== input.length || inspection.dependencies.some((s) => !input.some((r) => r?.sourceId === s.sourceId)) || input.some((r) => !r || !https(r.licenseUrl) || !https(r.provenanceUrl) || !text(r.attribution).trim())) {
    throw new HttpError(400, "Every source needs its license or public-domain statement, attribution, and rights provenance. Your private study remains available; complete those fields before approval.");
  }
  // Never persist arbitrary request properties into the release manifest.
  return input.map((r) => ({ sourceId: r.sourceId, licenseUrl: r.licenseUrl.trim(), attribution: r.attribution.trim(), provenanceUrl: r.provenanceUrl.trim() })).sort((a, b) => a.sourceId.localeCompare(b.sourceId));
}

export function approveResearchCorpus(db: DB, studyId: string, input: ResearchCorpusApproval): ResearchCorpusInspection {
  return db.transaction(() => {
    const current = checkedInspection(db, studyId, input.expectedHash);
    if (current.blockers.length || !current.preview) throw new HttpError(409, current.blockers[0]?.message ?? "This research is unavailable for corpus review. Your study is saved; prepare a neutral brief first.");
    if (input.reviewedPrivacy !== true || input.reviewedQuality !== true || input.reviewedRights !== true) throw new HttpError(400, "Privacy, research quality, and source rights each need your review. Your private study is unchanged; inspect the complete copy and confirm each review.");
    const rights = sourceRights(input.sourceRights, current);
    db.prepare("INSERT OR IGNORE INTO research_corpus_packages (content_hash, primary_ref, translation_id, data_json, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(current.hash, current.preview.passage.canonicalRef, current.preview.passage.translationId, JSON.stringify(current.preview), nowIso());
    db.prepare(`INSERT INTO research_corpus_decisions (id, study_id, content_hash, decision, reviewed_privacy, reviewed_quality, reviewed_rights, source_rights_json, created_at) VALUES (?, ?, ?, 'approved', 1, 1, 1, ?, ?)`)
      .run(uuidv7(), studyId, current.hash, JSON.stringify(rights), nowIso());
    return checkedInspection(db, studyId);
  })();
}

export function revokeResearchCorpus(db: DB, studyId: string, input: { expectedHash: string }): ResearchCorpusInspection {
  return db.transaction(() => {
    const current = checkedInspection(db, studyId, input.expectedHash);
    db.prepare("INSERT INTO research_corpus_decisions (id, study_id, content_hash, decision, created_at) VALUES (?, ?, ?, 'revoked', ?)").run(uuidv7(), studyId, current.hash, nowIso());
    return checkedInspection(db, studyId);
  })();
}

/** Export is a fresh snapshot of precisely the reviewed allowlist, never SELECT * serialized to JSON. */
export function buildResearchCorpusExport(db: DB, studyId: string): ResearchCorpusExport | null {
  return db.transaction((): ResearchCorpusExport | null => {
    const current = inspect(db, studyId);
    if (!current) return null;
    if (current.status !== "approved" || !current.preview || !current.review) throw new HttpError(409, current.blockers[0]?.message ?? "This research has no current corpus approval. Your study remains private and saved; inspect and approve the exact copy before exporting.");
    const decision = latestDecision(db, studyId)!;
    const rights = sourceRights(json<ResearchSourceRights[]>(decision.source_rights_json, []), current);
    const saved = db.prepare("SELECT data_json FROM research_corpus_packages WHERE content_hash = ?").get(current.hash) as { data_json: string };
    const data = JSON.parse(saved.data_json) as ResearchCorpusData;
    return { format: "personal-commentary.research-corpus", version: 1, scope: "neutral", exportedAt: nowIso(),
      manifest: { dataSha256: sha256(saved.data_json), reviewHash: current.hash, reviewId: current.review.id, reviewedAt: current.review.createdAt,
        totalCostMicros: data.costEvents.reduce((sum, c) => sum + c.usdMicros, 0), costBasis: "unique-cost-events", sourceRights: rights, cloudSyncEnabled: false }, data };
  })();
}
