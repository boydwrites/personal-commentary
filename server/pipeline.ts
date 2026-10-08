// Research runs: passage → gather (Scripture, words, voices, tradition; parallel) → the study brief (three model calls, parallel) → verify (deterministic). Spec §15.
import type { DB } from "./db.ts";
import { uuidv7, nowIso, json, indexEntity } from "./db.ts";
import { emit } from "./events.ts";
import { log } from "./log.ts";
import { getChapter, getPassage, verseCount, chapterCount, versesToText, expandRange, type TranslationRef } from "./bible.ts";
import { gatherHcf, gatherCrossRefs, gatherBibleHub, hcfAvailable, openbibleAvailable, hcfLocLabel } from "./sources/gatherers.ts";
import { bookByUsfm, displayRef, fromUsfm, parseReference, toOpenBible, findReferencesInText, type PassageRange } from "../shared/refs.ts";
import { callStructured, ModelError } from "./llm.ts";
import { BudgetError } from "./costs.ts";
import {
  researchSystemPrompt, connectionsPrompt, CONNECTIONS_SCHEMA, type ConnectionsOutput, scriptureBriefPrompt, backgroundBriefPrompt, voicesBriefPrompt, SCRIPTURE_BRIEF_SCHEMA, BACKGROUND_BRIEF_SCHEMA, VOICES_BRIEF_SCHEMA, VERSIONS,
  type BriefInputs, type BriefCard, type ScriptureBriefOutput, type BackgroundBriefOutput, type VoicesBriefOutput,
} from "./prompts.ts";
import { verifyCard, verseMarkerRegex, loadRunExcerpts, dequoteProse, type ExcerptRow } from "./verify.ts";
import { stepbibleAvailable, wordsFor, lexicon, occurrences, isContentWord, plainTranslit, type LexEntry } from "./sources/stepbible.ts";
import { keyUses } from "./words.ts";
import { normalize } from "../shared/text.ts";
import { gatherBibleHubChapter, gatherEnduringWord, gatherSkipDevos, type VoiceText } from "./sources/voices.ts";
import { discoverVoices } from "./discover.ts";
import { getSecret } from "./secrets.ts";
import { HttpError } from "./errors.ts";
import { words } from "../shared/text.ts";
import { storeSourceSnapshot } from "./sources/snapshots.ts";
import { researchIdentity, researchInputFingerprint, researchEvidenceFingerprint, intactResearchEvidence, unchangedResearchSources } from "./research-profile.ts";

type Range = { book: string; c1: number; v1: number; c2: number; v2: number };
export interface WordData {
  strong: string; lemma: string; translit: string; gloss: string; pos: string; definition: string; count: number;
  uses: { ref: string; text: string; rendering?: string }[]; in_verse: { ref: string; word: string; translit: string; gloss: string }; language: string;
}

// In order of authority: Scripture, then the user's preachers and pastors, then the wider tradition.
export const STAGES = [
  { key: "P", label: "The passage" },
  { key: "G3", label: "Scripture on Scripture" },
  { key: "L", label: "Hebrew and Greek words" },
  { key: "G5", label: "Preachers and pastors" },
  { key: "G4", label: "Classic commentaries" },
  { key: "G1", label: "Church Fathers" },
  { key: "SA", label: "Brief: Scripture and Jesus" },
  { key: "SB", label: "Brief: words, history, and culture" },
  { key: "SC", label: "Brief: what the voices say" },
  { key: "V", label: "Checking every quotation" },
] as const;
type StageKey = (typeof STAGES)[number]["key"];
type StageState = { status: "queued" | "running" | "done" | "skipped" | "failed"; detail?: string; error?: string; started_at?: string; finished_at?: string };

const controllers = new Map<string, AbortController>();
const queue: string[] = [];
let running = false;

export function recoverInterruptedRuns(db: DB) {
  const n = db
    .prepare("UPDATE research_runs SET status = 'failed', error = 'Interrupted when the app restarted. Retry to run it again.', finished_at = ? WHERE status IN ('queued','running')")
    .run(nowIso()).changes;
  if (n) log("warn", "pipeline", "recovered_interrupted_runs", { count: n });
}

export function enqueueRun(db: DB, studyId: string, depth: "standard" | "deeper", trigger: "manual" | "scheduled" = "manual", fill?: { of: string; parts: BriefKey[] }): string {
  const id = uuidv7();
  const stages: Record<string, StageState> = {};
  for (const s of STAGES) stages[s.key] = { status: "queued" };
  const study = db.prepare("SELECT primary_ref, translation_id FROM studies WHERE id = ?").get(studyId) as any;
  const identity = researchIdentity(db, study.primary_ref, study.translation_id);
  db.prepare("INSERT INTO research_runs (id, study_id, depth, trigger, status, stages_json, prompt_version, queued_at, brief_json, research_scope, compatibility_key, research_profile_json) VALUES (?,?,?,?,?,?,?,?,?,'neutral',?,?)").run(
    id, studyId, depth, trigger, "queued", JSON.stringify(stages), `${VERSIONS.brief_scripture}+${VERSIONS.brief_background}+${VERSIONS.brief_voices}`, nowIso(),
    JSON.stringify(fill ? { fill_of: fill.of, fill_parts: fill.parts } : {}),
    identity.compatibilityKey, JSON.stringify(identity.profile),
  );
  queue.push(id);
  void pump(db);
  return id;
}

// ---------- Research is bought once per passage ----------
// Every run costs money, and everything it finds is kept. So a study's brief is never researched twice: a passage
// already researched in another study gets that research copied in at no cost, a finished brief can't be run again,
// Go deeper runs once, and a brief that stopped partway can only fill in the parts that are missing.

type BriefKey = "SA" | "SB" | "SC";

/** Items from Jewish commentary, from research before it was retired (Oct 3, 2026), unless the user marked one as standing out. Use inside a query on cards. */
export const HIDDEN_CARD_SQL = `(selected = 0 AND (COALESCE(author_id IN (SELECT id FROM authors WHERE tradition = 'jewish'), 0)
  OR (EXISTS (SELECT 1 FROM card_evidence ce JOIN excerpts e ON e.id = ce.excerpt_id JOIN sources s ON s.id = e.source_id WHERE ce.card_id = cards.id AND s.kind = 'sefaria_text')
      AND NOT EXISTS (SELECT 1 FROM card_evidence ce JOIN excerpts e ON e.id = ce.excerpt_id JOIN sources s ON s.id = e.source_id WHERE ce.card_id = cards.id AND s.kind != 'sefaria_text'))))`;
const BRIEF_KEYS: BriefKey[] = ["SA", "SB", "SC"];

type RunRow = { id: string; study_id: string; depth: string; status: string; stages_json: string; brief_json: string; queued_at: string; finished_at: string | null; research_scope: string; compatibility_key: string | null; research_profile_json: string; input_fingerprint: string | null };
const runsWithCards = (db: DB, studyId: string) =>
  db.prepare("SELECT r.* FROM research_runs r WHERE r.study_id = ? AND EXISTS (SELECT 1 FROM cards c WHERE c.run_id = r.id) ORDER BY r.queued_at, r.id").all(studyId) as RunRow[];
const isFill = (r: RunRow) => !!json<any>(r.brief_json, {}).fill_of;

/** The run a study's brief rests on: its latest full standard run that found anything. */
export function baseRun(db: DB, studyId: string): RunRow | null {
  return runsWithCards(db, studyId).filter((r) => r.depth === "standard" && !isFill(r)).at(-1) ?? null;
}

/** Brief parts (Scripture, background, voices) that never finished for the current brief. */
export function missingParts(db: DB, studyId: string): BriefKey[] {
  const base = baseRun(db, studyId);
  if (!base) return [];
  const runs = (db.prepare("SELECT * FROM research_runs WHERE study_id = ? AND queued_at >= ? ORDER BY queued_at").all(studyId, base.queued_at) as RunRow[]).filter((r) => (r.id === base.id || json<any>(r.brief_json, {}).fill_of === base.id) && r.research_scope === base.research_scope && r.compatibility_key === base.compatibility_key);
  return BRIEF_KEYS.filter((k) => !runs.some((r) => json<any>(r.stages_json, {})[k]?.status === "done"));
}

/** Go deeper has run once it finished, even when everything it found was already in the brief. */
const deeperDone = (db: DB, studyId: string) => {
  const base = baseRun(db, studyId);
  return !!base && !!db.prepare("SELECT 1 FROM research_runs r WHERE r.study_id = ? AND r.queued_at >= ? AND r.research_scope = ? AND r.compatibility_key IS ? AND r.depth = 'deeper' AND (r.status IN ('succeeded','partial') OR EXISTS (SELECT 1 FROM cards c WHERE c.run_id = r.id))").get(studyId, base.queued_at, base.research_scope, base.compatibility_key);
};

export function researchState(db: DB, studyId: string) {
  const base = baseRun(db, studyId);
  const deeper = deeperDone(db, studyId);
  const study = db.prepare("SELECT primary_ref, translation_id FROM studies WHERE id = ?").get(studyId) as any;
  const key = study ? researchIdentity(db, study.primary_ref, study.translation_id).compatibilityKey : null;
  return { researched: !!base, deeperDone: deeper, missing: missingParts(db, studyId),
    neutralReady: !!base && base.research_scope === "neutral" && base.compatibility_key === key && intactResearchEvidence(db, studyId, key!) && unchangedResearchSources(db, studyId, key!),
    researchScope: base?.research_scope ?? null };
}

/** Only a finished, compatible neutral brief with no known disputed interpretation is an automatic donor. */
export function reusableResearchDonor(db: DB, studyId: string, key: string) {
  const candidates = db.prepare(`SELECT s.id, s.display_ref, r.finished_at, r.id AS run_id FROM studies s JOIN research_runs r ON r.study_id = s.id
    WHERE s.id != ? AND r.depth = 'standard' AND r.research_scope = 'neutral' AND r.compatibility_key = ?
      AND r.input_fingerprint IS NOT NULL AND r.status IN ('succeeded','partial')
      AND json_extract(r.brief_json, '$.fill_of') IS NULL
      AND json_extract(r.brief_json, '$.reused_from') IS NULL
      AND EXISTS (SELECT 1 FROM cards c WHERE c.run_id = r.id)
      AND NOT EXISTS (SELECT 1 FROM cards c JOIN research_runs bad ON bad.id = c.run_id
        WHERE bad.study_id = s.id AND bad.compatibility_key = ? AND bad.queued_at >= r.queued_at AND c.status_interpretation = 'disputed')
    ORDER BY r.queued_at DESC, r.id DESC`).all(studyId, key, key) as { id: string; display_ref: string; finished_at: string; run_id: string }[];
  return candidates.find((candidate) => baseRun(db, candidate.id)?.id === candidate.run_id && intactResearchEvidence(db, candidate.id, key) && unchangedResearchSources(db, candidate.id, key));
}

/**
 * Starts (or reuses) research for a study. Never pays twice for the same thing:
 * - "standard": refused once the study has a brief; copied from another study of the same passage when one exists.
 * - "deeper": once per brief.
 * - "fill": only the brief parts that didn't finish, from a partial run.
 */
export function requestResearch(db: DB, studyId: string, depth: "standard" | "deeper" | "fill"): { runId: string; reused?: { studyId: string; displayRef: string; date: string } } {
  const busy = db.prepare("SELECT id FROM research_runs WHERE study_id = ? AND status IN ('queued','running')").get(studyId) as any;
  if (busy) return { runId: busy.id };
  const study = db.prepare("SELECT * FROM studies WHERE id = ?").get(studyId) as any;
  if (!study) throw new HttpError(404, "This study could not be found. Your other studies are saved; return to the Library.");
  const base = baseRun(db, studyId);
  const { compatibilityKey } = researchIdentity(db, study.primary_ref, study.translation_id);
  const compatibleBase = base?.research_scope === "neutral" && base.compatibility_key === compatibilityKey && intactResearchEvidence(db, studyId, compatibilityKey) && unchangedResearchSources(db, studyId, compatibilityKey);
  if (depth === "standard") {
    if (compatibleBase) throw new HttpError(409, "This passage is already researched, and its brief is saved with this study. Research doesn't run twice, so nothing was spent.");
    const donor = reusableResearchDonor(db, studyId, compatibilityKey);
    if (donor) {
      const runId = copyResearch(db, donor.id, studyId, compatibilityKey);
      return { runId, reused: { studyId: donor.id, displayRef: donor.display_ref, date: donor.finished_at } };
    }
    return { runId: enqueueRun(db, studyId, "standard") };
  }
  if (!base) throw new HttpError(400, "Research this passage first.");
  if (!compatibleBase) throw new HttpError(409, "This brief came from an earlier version of research. Your notes, highlights, and writing are saved; refresh the research before going deeper.");
  if (depth === "deeper") {
    if (deeperDone(db, studyId)) throw new HttpError(409, "Go deeper has already run for this passage. Everything it found is in the brief, so nothing was spent.");
    return { runId: enqueueRun(db, studyId, "deeper") };
  }
  const parts = missingParts(db, studyId);
  if (!parts.length) throw new HttpError(409, "The brief is already complete, so nothing was spent.");
  return { runId: enqueueRun(db, studyId, "standard", "manual", { of: base.id, parts }) };
}

/** Copies a study's research (every run that found anything, with its items, evidence, gaps, and sources) into another study of the same passage. No model calls. */
export function copyResearch(db: DB, fromStudyId: string, toStudyId: string, compatibilityKey?: string): string {
  const donorBase = compatibilityKey ? baseRun(db, fromStudyId) : null;
  // Every run that found something, plus a finished Go deeper that found nothing new (so it isn't offered, and paid for, again).
  const from = (db.prepare("SELECT r.* FROM research_runs r WHERE r.study_id = ? AND r.status NOT IN ('queued','running') AND (EXISTS (SELECT 1 FROM cards c WHERE c.run_id = r.id) OR (r.depth = 'deeper' AND r.status IN ('succeeded','partial'))) ORDER BY r.queued_at, r.id").all(fromStudyId) as RunRow[])
    .filter((r) => !compatibilityKey || (r.research_scope === "neutral" && r.compatibility_key === compatibilityKey && !!r.input_fingerprint && ["succeeded", "partial"].includes(r.status) && !!donorBase && r.queued_at >= donorBase.queued_at));
  if (!from.length) throw new HttpError(409, "The earlier brief is still being prepared. Your notes are saved; try research again after it finishes.");
  const donor = db.prepare("SELECT id, display_ref, unit_ref, unit_label FROM studies WHERE id = ?").get(fromStudyId) as any;
  const now = Date.now();
  const ids = new Map<string, string>();
  from.forEach((r, i) => ids.set(r.id, uuidv7(now + i)));
  db.transaction(() => {
    from.forEach((r: any, i) => {
      const id = ids.get(r.id)!;
      const brief = json<any>(r.brief_json, {});
      if (brief.fill_of) brief.fill_of = ids.get(brief.fill_of) ?? brief.fill_of;
      brief.reused_from = brief.reused_from ?? { run_id: r.id, study_id: fromStudyId, display_ref: donor.display_ref, date: r.finished_at ?? r.queued_at };
      brief.reuse_scope = r.research_scope === "neutral" ? "neutral_passage" : "earlier_study_context";
      const at = new Date(now + i).toISOString();
      db.prepare(
        `INSERT INTO research_runs (id, study_id, depth, trigger, status, stages_json, prompt_version, context_summary, qualification, writer_questions_json, usd_micros, error, queued_at, started_at, finished_at, brief_json, research_scope, compatibility_key, research_profile_json, input_fingerprint)
         VALUES (?,?,?,?,?,?,?,?,?,?,0,?,?,?,?,?,?,?,?,?)`,
      ).run(id, toStudyId, r.depth, r.trigger, r.status, r.stages_json, r.prompt_version, r.context_summary, r.qualification, r.writer_questions_json, r.error, at, at, at, JSON.stringify(brief), r.research_scope, r.compatibility_key, r.research_profile_json, r.input_fingerprint);
      db.prepare("INSERT OR IGNORE INTO run_sources (run_id, source_id, stage) SELECT ?, source_id, stage FROM run_sources WHERE run_id = ?").run(id, r.id);
      db.prepare("INSERT INTO gaps (id, run_id, author_name, note, created_at) SELECT lower(hex(randomblob(16))), ?, author_name, note, created_at FROM gaps WHERE run_id = ?").run(id, r.id);
      const cards = db.prepare("SELECT * FROM cards WHERE run_id = ? ORDER BY priority, created_at").all(r.id) as any[];
      for (const c of cards) {
        const cid = uuidv7();
        const data = json<Record<string, any>>(c.data_json, {});
        data.reused_from ??= { card_id: c.id, run_id: r.id, study_id: fromStudyId, status_interpretation: c.status_interpretation, dispute_reason: c.dispute_reason };
        // The new study starts unreviewed. A known dispute stays visible so reuse cannot resurrect rejected evidence.
        const interpretation = c.status_interpretation === "disputed" ? "disputed" : "unreviewed";
        db.prepare(
          `INSERT INTO cards (id, run_id, study_id, type, title, body, body_model, relationship, author_id, author_name, limitation, disagreement, priority, visible_by_default,
            status_source, status_quote, status_interpretation, dispute_reason, flags_json, selected, created_at, section, group_label, data_json)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?)`,
        ).run(cid, id, toStudyId, c.type, c.title, c.body, c.body_model, c.relationship, c.author_id, c.author_name, c.limitation, c.disagreement, c.priority, c.visible_by_default,
          c.status_source, c.status_quote, interpretation, interpretation === "disputed" ? c.dispute_reason : null, c.flags_json, c.created_at, c.section, c.group_label, JSON.stringify(data));
        db.prepare(
          "INSERT INTO card_evidence (id, card_id, excerpt_id, use, quote_text, match, match_start, match_end, near_match) SELECT lower(hex(randomblob(16))), ?, excerpt_id, use, quote_text, match, match_start, match_end, near_match FROM card_evidence WHERE card_id = ?",
        ).run(cid, c.id);
        indexEntity(db, "card", cid, toStudyId, c.title, `${c.author_name ?? ""} ${c.body}`);
      }
      if (r.research_scope === "neutral") db.prepare("UPDATE research_runs SET evidence_fingerprint = ? WHERE id = ?").run(researchEvidenceFingerprint(db, id), id);
    });
    if (donor.unit_label) db.prepare("UPDATE studies SET unit_ref = COALESCE(unit_ref, ?), unit_label = COALESCE(unit_label, ?), updated_at = ? WHERE id = ?").run(donor.unit_ref, donor.unit_label, nowIso(), toStudyId);
  })();
  const last = ids.get(from.at(-1)!.id)!;
  log("info", "pipeline", "research_reused", { from: fromStudyId, to: toStudyId, runs: from.length });
  emit("run", { runId: last, studyId: toStudyId, status: "succeeded" });
  return last;
}

export function cancelRun(db: DB, runId: string) {
  const qi = queue.indexOf(runId);
  if (qi >= 0) queue.splice(qi, 1);
  controllers.get(runId)?.abort();
  db.prepare("UPDATE research_runs SET status = 'cancelled', finished_at = ? WHERE id = ? AND status IN ('queued','running')").run(nowIso(), runId);
  emit("run", { runId, status: "cancelled" });
}

async function pump(db: DB) {
  if (running) return;
  running = true;
  try {
    while (queue.length) {
      const id = queue.shift()!;
      const ac = new AbortController();
      controllers.set(id, ac);
      const hardLimit = setTimeout(() => ac.abort(new Error("time_limit")), 8 * 60_000);
      try {
        await runResearch(db, id, ac.signal);
      } catch (e) {
        log("error", "pipeline", "run_crashed", { runId: id, error: String(e) });
        db.prepare("UPDATE research_runs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?").run(e instanceof Error ? e.message : String(e), nowIso(), id);
        emit("run", { runId: id, status: "failed" });
      } finally {
        clearTimeout(hardLimit);
        controllers.delete(id);
      }
    }
  } finally {
    running = false;
  }
}

// ---------- helpers ----------

/** Best window of ≤ maxLen characters on paragraph/sentence boundaries, scored by verse markers and distinctive words (§14.5). */
export function bestWindow(text: string, verses: { c: number; v: number }[], verseText: string, maxLen = 2500): { start: number; end: number } {
  if (text.length <= maxLen) return { start: 0, end: text.length };
  const stop = new Set("the and of to a in that i is for it with as was his he be on not by but at this they you all have from are or will my me your thee thou thy unto shall".split(" "));
  const distinctive = [...new Set(words(verseText).filter((w) => w.length > 3 && !stop.has(w)))];
  const paras: { start: number; end: number; score: number }[] = [];
  const re = /[^\n]+/g;
  for (const m of text.matchAll(re)) {
    const p = m[0];
    let score = 0;
    if (verses.some((u) => verseMarkerRegex(u.c, u.v).test(p))) score += 5;
    const pw = new Set(words(p));
    for (const w of distinctive) if (pw.has(w)) score += 1;
    paras.push({ start: m.index!, end: m.index! + p.length, score });
  }
  let best = { start: 0, end: Math.min(text.length, maxLen), score: -1 };
  for (let i = 0; i < paras.length; i++) {
    let score = 0;
    let j = i;
    while (j < paras.length && paras[j].end - paras[i].start <= maxLen) {
      score += paras[j].score;
      j++;
    }
    if (j === i) {
      // a single paragraph longer than the window: center on it
      const end = Math.min(text.length, paras[i].start + maxLen);
      const cut = text.lastIndexOf(". ", end);
      if (paras[i].score > best.score) best = { start: paras[i].start, end: cut > paras[i].start + 200 ? cut + 1 : end, score: paras[i].score };
      continue;
    }
    if (score > best.score) best = { start: paras[i].start, end: paras[j - 1].end, score };
  }
  return { start: best.start, end: best.end };
}

// ---------- the run ----------

async function runResearch(db: DB, runId: string, signal: AbortSignal) {
  const run = db.prepare("SELECT * FROM research_runs WHERE id = ?").get(runId) as any;
  if (!run || run.status !== "queued") return;
  const study = db.prepare("SELECT * FROM studies WHERE id = ?").get(run.study_id) as any;
  const identity = researchIdentity(db, study.primary_ref, study.translation_id);
  if (run.research_scope !== "neutral" || run.compatibility_key !== identity.compatibilityKey) {
    finish(db, runId, "failed", "The research profile changed before this work started. Your notes and earlier research are saved; start research again.");
    return;
  }
  // Freeze retrieval configuration for this run. Changes made while network requests are in flight affect the next run.
  const authors = identity.profile.authors as any[];
  const priorBase = baseRun(db, study.id);
  const since = priorBase?.queued_at ?? run.queued_at;
  // Queued studies may request the same passage before the first finishes. Recheck after waiting, before any paid call.
  if (run.depth === "standard" && !json<any>(run.brief_json, {}).fill_of) {
    const donor = reusableResearchDonor(db, study.id, identity.compatibilityKey);
    if (donor) {
      const attachmentId = copyResearch(db, donor.id, study.id, identity.compatibilityKey);
      db.prepare("UPDATE research_runs SET brief_json = ? WHERE id = ?").run(JSON.stringify({ reuse_attachment_run_id: attachmentId }), runId);
      finish(db, runId, "succeeded", null);
      return;
    }
  }
  const deeper = run.depth === "deeper";
  // A fill run writes only the brief parts a partial run missed, and skips the paid searches the other parts need.
  const fillParts: BriefKey[] | null = json<any>(run.brief_json, {}).fill_of ? json<any>(run.brief_json, {}).fill_parts ?? [] : null;
  const needs = (k: BriefKey) => !fillParts || fillParts.includes(k);
  const t: TranslationRef = { id: study.translation_id };
  const range = fromUsfm(study.primary_ref)! as Range;
  const stages = json<Record<StageKey, StageState>>(run.stages_json, {} as any);
  const startedAt = Date.now();

  const save = () => {
    db.prepare("UPDATE research_runs SET stages_json = ? WHERE id = ?").run(JSON.stringify(stages), runId);
    emit("run", { runId, studyId: study.id, stages });
  };
  const set = (k: StageKey, s: Partial<StageState>) => {
    stages[k] = { ...stages[k], ...s };
    if (s.status === "running") stages[k].started_at = nowIso();
    if (s.status && ["done", "failed", "skipped"].includes(s.status)) stages[k].finished_at = nowIso();
    save();
  };
  db.prepare("UPDATE research_runs SET status = 'running', started_at = ? WHERE id = ?").run(nowIso(), runId);
  emit("run", { runId, studyId: study.id, status: "running" });

  const link = db.prepare("INSERT OR IGNORE INTO run_sources (run_id, source_id, stage) VALUES (?,?,?)");
  // group orders excerpts by authority (0 the passage, 1 other Scripture, 2 preferred preachers, …); rank breaks ties by the user's order.
  type Ex = { sourceId: string; text: string; start: number; end: number; refs: { c: number; v: number; v2?: number }[]; group: number; rank?: number; book?: string; meta: Record<string, string> };
  const exs: Ex[] = [];
  const gaps: { author: string; note: string }[] = [];
  const unitVerses: { c: number; v: number }[] = [];
  for (let c = range.c1; c <= range.c2; c++) {
    const from = c === range.c1 ? range.v1 : 1;
    const to = c === range.c2 ? range.v2 : verseCount(range.book, c);
    for (let v = from; v <= to; v++) unitVerses.push({ c, v });
  }

  // ---- P: passage text ----
  set("P", { status: "running" });
  let chapterText = "";
  let passageText = "";
  try {
    const lo = deeper ? Math.max(1, range.c1 - 1) : range.c1;
    const hi = deeper ? Math.min(chapterCount(range.book), range.c2 + 1) : range.c2;
    const book = bookByUsfm(range.book)!;
    const pieces: string[] = [];
    for (let c = lo; c <= hi; c++) {
      const ch = await getChapter(t, range.book, c);
      const text = ch.verses.map((v) => `[${c}:${v.n}] ${v.text}`).join("\n");
      pieces.push(`${book.name} ${c}\n${text}`);
      const sid = storeSourceSnapshot(db, { kind: "bible_text", datasetRef: `bible:${t.id}:${range.book}.${c}`, title: `${book.name} ${c} (${t.id})`, rights: t.id === "BSB" ? "public_domain" : "fair_use_excerpt", matchLevel: "scripture", text, discoveredBy: "dataset", httpStatus: 200 });
      link.run(runId, sid, "P");
      if (c >= range.c1 && c <= range.c2) {
        const vs = ch.verses.filter((v) => (c > range.c1 || v.n >= range.v1) && (c < range.c2 || v.n <= range.v2));
        const vText = vs.map((v) => `[${c}:${v.n}] ${v.text}`).join("\n");
        const start = text.indexOf(vText.split("\n")[0]);
        exs.push({ sourceId: sid, text: vText, start: Math.max(0, start), end: Math.max(0, start) + vText.length, refs: vs.map((v) => ({ c, v: v.n })), group: 0, meta: { kind: "bible_text", author: "", work: `${displayRef({ ...range })} (${t.id})`, rights: "public_domain", match_level: "scripture" } });
      }
    }
    chapterText = pieces.join("\n\n");
    passageText = versesToText(await getPassage(t, range));
    set("P", { status: "done", detail: `${displayRef(range)}${deeper ? " with neighboring chapters" : " with its chapter"}` });
  } catch (e) {
    set("P", { status: "failed", error: e instanceof Error ? e.message : String(e) });
    finish(db, runId, "failed", "The passage text couldn't be loaded, so research stopped.");
    return;
  }

  // Jewish commentary isn't gathered, so its voices are left out of the preferred list too.
  const preferred = authors.filter((a) => a.is_preferred && a.tradition !== "jewish").sort((a, b) => (a.preference_rank ?? 99) - (b.preference_rank ?? 99));
  const byHcfName = new Map<string, any>();
  for (const a of authors) for (const n of json<string[]>(a.hcf_names_json, [])) byHcfName.set(n, a);

  // ---- G1–G4 in parallel ----
  const g1 = (async () => {
    set("G1", { status: "running" });
    if (!hcfAvailable()) return set("G1", { status: "skipped", detail: "The Church Fathers database isn't downloaded yet (Settings → Data)." });
    const rows = gatherHcf(range, preferred.map((a) => ({ names: json<string[]>(a.hcf_names_json, []), rank: a.preference_rank ?? 99 })), deeper);
    for (const row of rows) {
      const a = byHcfName.get(row.father_name);
      const name = a?.display_name ?? row.father_name;
      const loc = hcfLocLabel(row);
      const sid = storeSourceSnapshot(db, {
        kind: "hcf_excerpt", datasetRef: `hcf:${row.id}`, url: row.source_url || null,
        title: `${name}${row.source_title ? ", " + titleCase(row.source_title) : ""} (on ${bookByUsfm(range.book)!.name} ${loc})`,
        authorId: a?.id ?? null, authorName: name, work: row.source_title ? titleCase(row.source_title) : null, locator: loc,
        edition: "Historical Christian Faith compilation", rights: "unknown", matchLevel: "compiled_excerpt", text: row.txt, discoveredBy: "dataset", httpStatus: 200,
      });
      link.run(runId, sid, "G1");
      const c = Math.floor(row.location_start / 1_000_000);
      const v = row.location_start % 1_000_000;
      const v2 = row.location_end % 1_000_000;
      const w = bestWindow(row.txt, unitVerses, passageText);
      exs.push({
        sourceId: sid, text: row.txt.slice(w.start, w.end), start: w.start, end: w.end, refs: [{ c, v, v2 }],
        group: a?.is_preferred ? (row.priority === 1 ? 3 : 5) : 7, rank: a?.preference_rank ?? 99,
        meta: { kind: "hcf_excerpt", author: name, work: row.source_title ? titleCase(row.source_title) : "", locator: `comments on ${bookByUsfm(range.book)!.name} ${loc}`, edition: "(compiled excerpt)", rights: "unknown", match_level: "compiled_excerpt", url: row.source_url ?? "" },
      });
    }
    const pAuthors = [...new Set(rows.map((r) => byHcfName.get(r.father_name)?.display_name ?? r.father_name))];
    const onVerse = rows.filter((r) => r.priority === 1).length;
    set("G1", { status: "done", detail: rows.length ? `${rows.length} excerpts from ${pAuthors.length} Fathers on ${bookByUsfm(range.book)!.name} ${range.c1}${onVerse ? `, ${onVerse} on these verses` : ", none on these verses directly"}` : "No Church Fathers in the database for this chapter" });
  })();

  const g3 = (async () => {
    set("G3", { status: "running" });
    // Two sources at once: openbible.info's voted cross-references, and connections a careful teacher would add
    // (echoes, word studies, how it points to Christ) that a concordance can't vote on.
    const addPassage = async (r: Range, osis: string, rank: number, locator: string, by: "dataset" | "model_search") => {
      if (r.c2 - r.c1 > 1) return false;
      const vs = await getPassage(t, r);
      if (!vs.length || vs.length > 4) return false;
      const text = vs.map((v) => `[${v.chapter}:${v.n}] ${v.text}`).join(" ");
      const label = displayRef(r);
      const sid = storeSourceSnapshot(db, { kind: "cross_reference", datasetRef: `xref:${t.id}:${osis}`, title: `${label} (${t.id})`, rights: t.id === "BSB" ? "public_domain" : "fair_use_excerpt", matchLevel: "scripture", text, discoveredBy: by, httpStatus: 200, locator: label });
      link.run(runId, sid, "G3");
      const testament = bookByUsfm(r.book)!.index >= 40 ? "new" : "old";
      exs.push({ sourceId: sid, text, start: 0, end: text.length, refs: [], group: 1, rank, book: r.book, meta: { kind: "cross_reference", author: "", work: `${label} (${t.id})`, locator, testament, rights: "public_domain", match_level: "scripture" } });
      return true;
    };
    const seen = new Set<string>();
    let voted = 0;
    if (openbibleAvailable()) {
      for (const x of gatherCrossRefs(range, deeper ? 32 : 24)) {
        try {
          const dir = x.direction === "from" ? "points to this passage" : x.direction === "both" ? "linked both ways" : "this passage points to it";
          if (await addPassage(x.range as Range, x.osis, -x.votes, `${x.votes} votes on openbible.info; ${dir}`, "dataset")) {
            seen.add(displayRef(x.range));
            voted++;
          }
        } catch {
          /* skip one unreadable target */
        }
      }
    }
    let suggested = 0;
    if (getSecret("openai_api_key") && needs("SA")) {
      try {
        const known = deeper ? (db.prepare("SELECT DISTINCT s.locator FROM sources s JOIN run_sources rs ON rs.source_id = s.id JOIN research_runs r ON r.id = rs.run_id WHERE r.study_id = ? AND r.id != ? AND r.queued_at >= ? AND r.research_scope = 'neutral' AND r.compatibility_key = ? AND s.kind = 'cross_reference'").all(study.id, runId, since, run.compatibility_key) as any[]).map((x) => x.locator) : [];
        const res = await callStructured<ConnectionsOutput>({
          db, stage: "connections", promptVersion: VERSIONS.connections, system: researchSystemPrompt(),
          user: connectionsPrompt({ displayRef: study.display_ref, passage: passageText, testament: bookByUsfm(range.book)!.index >= 40 ? "new" : "old", known }),
          schema: CONNECTIONS_SCHEMA, effort: "low", maxTokens: 4000, studyId: study.id, runId, signal,
        });
        for (const [i, c] of res.data.connections.slice(0, 12).entries()) {
          const p = parseReference(c.usfm);
          const r0 = fromUsfm(c.usfm.trim().toUpperCase()) ?? (p.ok ? p.range : null);
          const e = r0 ? expandRange(r0) : null;
          if (!e || !e.ok) continue;
          const r = e.range as Range;
          if (r.book === range.book && r.c1 === range.c1 && r.v1 >= range.v1 && r.v2 <= range.v2) continue;
          const label = displayRef(r);
          const why = `suggested connection (${c.kind.replace(/_/g, " ")}): ${c.why}`;
          if (seen.has(label)) {
            // Already voted in; carry the reason along.
            const ex = exs.find((x) => x.meta.kind === "cross_reference" && x.meta.work === `${label} (${t.id})`);
            if (ex) ex.meta.locator += `; ${why}`;
            continue;
          }
          try {
            if (await addPassage(r, `${toOpenBible(r.book, r.c1, r.v1)}${r.v2 !== r.v1 || r.c2 !== r.c1 ? `-${toOpenBible(r.book, r.c2, r.v2)}` : ""}`, -10_000 + i, why, "model_search")) {
              seen.add(label);
              suggested++;
            }
          } catch {
            /* a reference this translation numbers differently */
          }
        }
      } catch (e) {
        log("warn", "pipeline", "connections_failed", { runId, error: String(e) });
      }
    }
    if (!voted && !suggested) return set("G3", { status: openbibleAvailable() ? "done" : "skipped", detail: openbibleAvailable() ? "No connected passages found" : "Cross-references aren't downloaded yet (Settings → Data)." });
    set("G3", { status: "done", detail: `${voted + suggested} connected passages${suggested ? ` (${suggested} from reading the whole Bible)` : ""}` });
  })();

  const g4 = (async () => {
    set("G4", { status: "running" });
    const sections = await gatherBibleHub(range, signal);
    // Voices read from their full chapter commentary in G5 aren't repeated from the verse page.
    const bySection = new Map(authors.filter((a) => a.biblehub_section_title).map((a) => [a.biblehub_section_title, a]));
    const inG5 = new Set(authors.filter((a) => a.is_preferred && a.biblehub_chapter_slug).map((a) => a.biblehub_section_title).filter(Boolean));
    const seen = new Set<string>();
    const ordered = sections
      .map((s) => ({ s, a: bySection.get(s.sectionTitle) }))
      .sort((x, y) => (x.a?.is_preferred ? x.a.preference_rank ?? 50 : 100) - (y.a?.is_preferred ? y.a.preference_rank ?? 50 : 100));
    let n = 0;
    for (const { s, a } of ordered) {
      const sid = storeSourceSnapshot(db, {
        kind: "commentary_page", datasetRef: `biblehub:${s.url}#${s.sectionTitle}`, url: s.url, title: `${s.sectionTitle} on ${displayRef(range)}`,
        authorId: a?.id ?? null, authorName: a?.display_name ?? s.sectionTitle, work: s.sectionTitle, locator: displayRef(range),
        edition: "Bible Hub", rights: "public_domain", matchLevel: "primary_edition", text: s.text, discoveredBy: "directory", httpStatus: 200,
      });
      link.run(runId, sid, "G4");
      if (seen.has(s.sectionTitle) || inG5.has(s.sectionTitle) || n >= (deeper ? 6 : 4)) continue;
      seen.add(s.sectionTitle);
      n++;
      const w = bestWindow(s.text, unitVerses, passageText, 2000);
      exs.push({
        sourceId: sid, text: s.text.slice(w.start, w.end), start: w.start, end: w.end, refs: unitVerses.slice(0, 1), group: a?.is_preferred ? 3 : 4, rank: a?.preference_rank ?? 99,
        meta: { kind: "commentary_page", author: a?.display_name ?? s.sectionTitle, work: s.sectionTitle, locator: displayRef(range), edition: "Bible Hub (public domain)", rights: "public_domain", match_level: "primary_edition", url: s.url },
      });
    }
    set("G4", { status: "done", detail: `${new Set(sections.map((s) => s.sectionTitle)).size} commentaries` });
  })();

  // ---- L: the Hebrew and Greek words of the passage, with their lexicon entries and uses elsewhere ----
  const wordData = new Map<string, WordData>();
  const gl = (async () => {
    set("L", { status: "running" });
    if (!stepbibleAvailable()) return set("L", { status: "skipped", detail: "The Hebrew and Greek words aren't downloaded yet (Settings → Data)." });
    // Short passages also look one verse either side: verse divisions differ (2 Corinthians 10:5's "arguments" is 10:4 in Greek).
    const verses = unitVerses.slice(0, deeper ? 6 : 4);
    if (unitVerses.length <= 2) {
      const first = unitVerses[0];
      const last = unitVerses.at(-1)!;
      if (first.v > 1) verses.unshift({ c: first.c, v: first.v - 1 });
      if (last.v < verseCount(range.book, last.c)) verses.push({ c: last.c, v: last.v + 1 });
    }
    const found: { w: { word: string; translit: string; gloss: string; strong: string }; lex: LexEntry; at: { c: number; v: number }; count: number }[] = [];
    for (const at of verses) {
      for (const w of wordsFor(range.book, at.c, at.v)) {
        if (!w.strong || found.some((f) => f.w.strong === w.strong)) continue;
        const lex = lexicon(w.strong);
        if (!isContentWord(lex)) continue;
        found.push({ w: { ...w, translit: plainTranslit(w.translit) }, lex: { ...lex!, translit: plainTranslit(lex!.translit) }, at, count: occurrences(w.strong).count });
      }
    }
    // Keep the rarer words when there are many: they're where the original says most.
    const cap = deeper ? 20 : 16;
    // Words of the passage itself come first; neighbors fill what's left.
    const inPassage = (f: (typeof found)[number]) => unitVerses.some((u) => u.c === f.at.c && u.v === f.at.v);
    const ranked = [...found].sort((a, b) => Number(inPassage(b)) - Number(inPassage(a)) || a.count - b.count);
    const keep = new Set(ranked.slice(0, cap).map((f) => f.w.strong));
    const lang = bookByUsfm(range.book)!.index >= 40 ? "grc" : "he";
    for (const f of found.filter((x) => keep.has(x.w.strong))) {
      const occ = occurrences(f.w.strong);
      // The word's best-known uses outside the passage, one for each of its common English renderings first.
      const unit = unitVerses.length ? { book: range.book, c1: unitVerses[0].c, v1: unitVerses[0].v, c2: unitVerses.at(-1)!.c, v2: unitVerses.at(-1)!.v } : null;
      const uses = (await keyUses(f.w.strong, unit, occ.count > 100 ? 4 : 6)).key.map((k) => ({ ref: k.ref, text: k.text, rendering: k.rendering }));
      const definition = f.lex.definition.length > 900 ? f.lex.definition.slice(0, 900).replace(/\s\S*$/, "") + " …" : f.lex.definition;
      const here = displayRef({ book: range.book, c1: f.at.c, v1: f.at.v, c2: f.at.c, v2: f.at.v });
      const neighbor = !unitVerses.some((u) => u.c === f.at.c && u.v === f.at.v);
      const text = [
        `${f.lex.lemma} (${f.lex.translit}) — Strong's ${f.w.strong} — ${f.lex.gloss}`,
        `In ${here}${neighbor ? ` (the verse ${f.at.v < unitVerses[0].v ? "before" : "after"} the passage)` : ""}: ${f.w.word} (${f.w.translit}), translated "${f.w.gloss}"`,
        `Definition (STEPBible brief lexicon): ${definition}`,
        `Used ${occ.count} time${occ.count === 1 ? "" : "s"} in the ${lang === "he" ? "Old" : "New"} Testament.${uses.length ? " Best-known uses elsewhere:" : ""}`,
        ...uses.map((u) => `${u.ref} — ${u.text}`),
      ].join("\n");
      const sid = storeSourceSnapshot(db, {
        kind: "lexicon_entry", datasetRef: `stepbible:${f.w.strong}:${range.book}.${f.at.c}.${f.at.v}`, url: `https://www.stepbible.org/?q=strong=${f.w.strong}`,
        title: `${f.lex.lemma} (${f.lex.translit}), ${f.w.strong} — STEPBible`, authorName: null, work: "STEPBible brief lexicon", locator: f.w.strong, edition: "STEPBible.org (CC BY 4.0)",
        language: lang, rights: "cc_by", matchLevel: "primary_edition", text, discoveredBy: "dataset", httpStatus: 200,
      });
      link.run(runId, sid, "L");
      wordData.set(f.w.strong, {
        strong: f.w.strong, lemma: f.lex.lemma, translit: f.lex.translit, gloss: f.lex.gloss, pos: f.lex.pos, definition, count: occ.count, uses,
        in_verse: { ref: here, word: f.w.word, translit: f.w.translit, gloss: f.w.gloss }, language: lang,
      });
      exs.push({ sourceId: sid, text, start: 0, end: text.length, refs: [f.at], group: 1, rank: 1000 + f.count, meta: { kind: "lexicon_entry", author: "", work: "STEPBible brief lexicon", locator: here, strongs: f.w.strong, rights: "cc_by", match_level: "primary_edition" } });
    }
    set("L", { status: "done", detail: keep.size ? `${keep.size} ${lang === "he" ? "Hebrew" : "Greek"} words` : "No words found for this passage" });
  })();

  // ---- G5: the user's preachers and pastors — chapter commentaries, Enduring Word, devotionals, and searched sites ----
  const g5 = (async () => {
    set("G5", { status: "running" });
    const voices = preferred.filter((a) => a.biblehub_chapter_slug || a.gatherer || json<string[]>(a.web_domains_json, []).length);
    const found: { a: any; t: VoiceText; kind: "commentary_page" | "web_page"; by: "directory" | "model_search"; rights: string }[] = [];
    const pd = (a: any) => ["post_reformation", "reformation", "patristic_east", "patristic_west", "medieval"].includes(a.tradition) || a.id === "spurgeon";
    const direct = voices.flatMap((a) => {
      const jobs: Promise<void>[] = [];
      if (a.biblehub_chapter_slug) jobs.push(gatherBibleHubChapter(range, a.biblehub_chapter_slug, signal).then((ts) => { for (const t of ts) found.push({ a, t, kind: "commentary_page", by: "directory", rights: "public_domain" }); }));
      if (a.gatherer === "enduringword") jobs.push(gatherEnduringWord(range, signal).then((ts) => { for (const t of ts) found.push({ a, t, kind: "commentary_page", by: "directory", rights: "fair_use_excerpt" }); }));
      if (a.gatherer === "skip_devos") jobs.push(gatherSkipDevos(range, signal).then((ts) => { for (const t of ts) found.push({ a, t, kind: "web_page", by: "directory", rights: "fair_use_excerpt" }); }));
      return jobs;
    });
    // Search only for voices the direct gatherers can't reach.
    const webVoices = voices.filter((a) => !a.biblehub_chapter_slug && !a.gatherer && json<string[]>(a.web_domains_json, []).length)
      .map((a) => ({ id: a.id, name: a.display_name, sites: json<string[]>(a.web_domains_json, []) }));
    let searchNote = "";
    const web = getSecret("openai_api_key") && webVoices.length && needs("SC")
      ? discoverVoices(db, { range, displayRef: study.display_ref, verseText: passageText, voices: webVoices, studyId: study.id, runId, signal })
          .then((r) => { for (const p of r.found) { const a = voices.find((x) => x.id === p.authorId); if (a) found.push({ a, t: { text: p.text, url: p.url, locator: study.display_ref, title: p.title }, kind: "web_page", by: "model_search", rights: pd(a) ? "public_domain" : "fair_use_excerpt" }); } })
          .catch((e) => { searchNote = e instanceof BudgetError || e instanceof ModelError ? " Web search was skipped." : " Web search didn't finish."; log("warn", "pipeline", "discover_failed", { runId, error: String(e) }); })
      : Promise.resolve();
    await Promise.allSettled([...direct, web]);
    const perAuthor = new Map<string, number>();
    found.sort((x, y) => (x.a.preference_rank ?? 99) - (y.a.preference_rank ?? 99));
    for (const { a, t, kind, by, rights } of found) {
      const n = perAuthor.get(a.id) ?? 0;
      if (n >= 2) continue;
      perAuthor.set(a.id, n + 1);
      const sid = storeSourceSnapshot(db, {
        kind, datasetRef: `${by === "model_search" ? "web" : "voice"}:${t.url}#${t.locator}`, url: t.url, title: `${a.display_name}, ${t.title} (on ${t.locator})`,
        authorId: a.id, authorName: a.display_name, work: t.title, locator: t.locator, edition: new URL(t.url).hostname.replace(/^www\./, ""),
        rights, matchLevel: "primary_edition", text: t.text, discoveredBy: by, httpStatus: 200,
      });
      link.run(runId, sid, "G5");
      const w = bestWindow(t.text, unitVerses, passageText, 2500);
      exs.push({
        sourceId: sid, text: t.text.slice(w.start, w.end), start: w.start, end: w.end, refs: unitVerses.slice(0, 1), group: 2, rank: a.preference_rank ?? 99,
        meta: { kind, author: a.display_name, work: t.title, locator: t.locator, rights, match_level: "primary_edition", url: t.url },
      });
    }
    const names = [...perAuthor.keys()].map((id) => voices.find((a) => a.id === id)!.display_name);
    set("G5", { status: "done", detail: (names.length ? names.join(", ") : "None found on this passage") + searchNote });
  })();

  const results = await Promise.allSettled([g1, g3, gl, g4, g5]);
  results.forEach((r, i) => {
    if (r.status === "rejected") {
      const k = (["G1", "G3", "L", "G4", "G5"] as StageKey[])[i];
      set(k, { status: "failed", error: friendly(r.reason) });
    }
  });
  if (signal.aborted) return finish(db, runId, "cancelled", null);

  // ---- excerpts for the model (≤70, ≈300k characters), in order of authority ----
  exs.sort((a, b) => a.group - b.group || (a.rank ?? 99) - (b.rank ?? 99));
  const kept: Ex[] = [];
  let chars = 0;
  for (const e of exs) {
    if (kept.length >= 70 || chars + e.text.length > 300_000) break;
    kept.push(e);
    chars += e.text.length;
  }
  const insEx = db.prepare("INSERT INTO excerpts (id, run_id, short_id, source_id, start_offset, end_offset, text, refs_json) VALUES (?,?,?,?,?,?,?,?)");
  const rendered: { id: string; kind: string; group: number; book?: string; author: string; text: string; short: string }[] = [];
  db.transaction(() => {
    kept.forEach((e, i) => {
      const shortId = `ex_${String(i + 1).padStart(2, "0")}`;
      insEx.run(uuidv7(), runId, shortId, e.sourceId, e.start, e.end, e.text, JSON.stringify(e.refs));
      const attrs = Object.entries(e.meta).map(([k, v]) => `${k}="${String(v).replace(/"/g, "'")}"`).join(" ");
      const tag = (body: string) => `<excerpt id="${shortId}" ${attrs}>\n${body}\n</excerpt>`;
      // The Scripture call sees voices only for how they point to Christ; a shorter window keeps it focused.
      rendered.push({ id: shortId, kind: e.meta.kind, group: e.group, book: e.book, author: e.meta.author ?? "", text: tag(e.text), short: tag(e.text.length > 1500 ? e.text.slice(0, 1500) + " …" : e.text) });
    });
  })();
  const scriptureKinds = new Set(["bible_text", "cross_reference", "lexicon_entry"]);
  const evidenceFor = (which: "scripture" | "background" | "voices") =>
    rendered
      .filter((r) => (which === "scripture" ? scriptureKinds.has(r.kind) || r.group <= 3 : which === "background" ? r.kind !== "cross_reference" : !scriptureKinds.has(r.kind) || r.kind === "bible_text"))
      .map((r) => (which === "scripture" && !scriptureKinds.has(r.kind) ? r.short : r.text))
      .join("\n\n");

  // ---- SA, SB, SC: the study brief, written in three parts at once ----
  const previousCards = deeper
    ? (db.prepare("SELECT c.section, c.type, c.title, c.author_name FROM cards c JOIN research_runs r ON r.id = c.run_id WHERE c.study_id = ? AND c.run_id != ? AND r.queued_at >= ? AND r.research_scope = 'neutral' AND r.compatibility_key = ? AND c.status_interpretation != 'disputed' ORDER BY r.queued_at, c.priority, c.id").all(study.id, runId, since, run.compatibility_key) as any[]).map((c) => `- [${c.section ?? c.type}] ${c.title}${c.author_name ? ` (${c.author_name})` : ""}`).join("\n")
    : null;
  const testament: "old" | "new" = bookByUsfm(range.book)!.index >= 40 ? "new" : "old";
  const base: Omit<BriefInputs, "excerpts"> = {
    displayRef: displayRef(range), translation: t.id, unitHint: unitHint(range), previousCards, chapterText,
    gaps: gaps.map((g) => `${g.author}: ${g.note}`).join("; "),
    preferred: preferred.map((a, i) => `${i + 1}. ${a.full_identity}`).join("\n"), deeper, testament,
    presentVoices: preferred.map((a) => a.display_name).filter((n) => kept.some((e) => e.meta.author === n)),
  };
  // A dataset replaced during gathering must not be labeled with the earlier dataset version.
  const afterGathering = researchIdentity(db, study.primary_ref, study.translation_id);
  if (JSON.stringify(afterGathering.profile.datasets) !== JSON.stringify(identity.profile.datasets)) {
    finish(db, runId, "failed", "A source dataset changed during research. Your notes and retrieved evidence are saved; start research again with the updated dataset.");
    return;
  }
  db.prepare("UPDATE research_runs SET input_fingerprint = ? WHERE id = ?").run(researchInputFingerprint(db, runId, {
    compatibility_key: run.compatibility_key, depth: run.depth, fill_parts: fillParts, base,
    rendered_evidence: rendered.map(({ text, short }) => ({ text, short })),
  }), runId);

  const excerptMap = loadRunExcerpts(db, runId);
  const knownAuthor = (name: string) => {
    const a = authors.find((x) => x.display_name.toLowerCase() === name.toLowerCase() || json<string[]>(x.hcf_names_json, []).some((n) => n.toLowerCase() === name.toLowerCase()) || x.sefaria_collective_title?.toLowerCase() === name.toLowerCase() || x.biblehub_section_title?.toLowerCase() === name.toLowerCase());
    if (a) return { care_note: a.care_note, condemned: !!a.condemned_by_council };
    const fromSource = [...excerptMap.values()].some((ex) => ex.author_name?.toLowerCase() === name.toLowerCase());
    return fromSource ? { care_note: null, condemned: false } : null;
  };
  const bookOf = new Map(rendered.filter((r) => r.book).map((r) => [r.id, r.book!]));
  // Go deeper adds to the brief the user has, so it skips what's already there; a fresh run replaces it and starts clean.
  const existing = deeper || fillParts ? (db.prepare("SELECT c.section, c.title, ce.quote_text FROM cards c JOIN research_runs r ON r.id = c.run_id LEFT JOIN card_evidence ce ON ce.card_id = c.id WHERE c.study_id = ? AND c.run_id != ? AND r.queued_at >= ? AND r.research_scope = 'neutral' AND r.compatibility_key = ? AND c.status_interpretation != 'disputed'").all(study.id, runId, since, run.compatibility_key) as any[]) : [];
  const seenKeys = new Set<string>();
  for (const e of existing) {
    seenKeys.add(`t:${e.section}:${normalize(e.title ?? "").text}`);
    if (e.quote_text) seenKeys.add(`q:${normalize(e.quote_text).text}`);
  }
  let matched = 0;
  let dequoted = 0;
  let briefCards = 0;

  /** Verifies one call's items and stores them, so each section appears as soon as it's ready. */
  const storeCards = (cards: BriefCard[]) => {
    const kept: { c: BriefCard; v: ReturnType<typeof verifyCard>; data: any }[] = [];
    for (const c of cards) {
      // The brief is written to its reader; a stray "the user's" reads as if about someone else.
      for (const k of ["title", "body", "limitation", "disagreement"] as const) if (c[k]) c[k] = toReader(c[k]!);
      if ((c.section === "commentary" || c.section === "tradition") && !c.author) continue; // a voice item always has a voice
      let data: any = {};
      if (c.section === "language") {
        const w = c.strongs ? wordData.get(c.strongs.trim()) ?? wordData.get(c.strongs.trim().replace(/[A-Z]$/, "")) : null;
        if (!w) continue; // a word study must rest on a word of this passage
        data = w;
      }
      const v = verifyCard(c, excerptMap, { book: range.book, verses: unitVerses }, knownAuthor, [15, 120]);
      if (c.section === "scripture" || c.section === "christ") {
        data.refs = [...new Set(c.evidence.map((e) => excerptMap.get(e.excerpt_id)).filter((x) => x && x.kind === "cross_reference").map((x) => x!.source_locator))];
        // No cited passage (it rested on a word study, say): label it with the references its own words name.
        if (!data.refs.length) data.refs = [...new Set(findReferencesInText(`${c.title} ${c.body}`, range.book).map((r) => displayRef(r.range)))].filter((l) => l !== study.display_ref).slice(0, 3);
      }
      if (c.section === "christ" && c.group === "fulfilled") {
        const other = c.evidence.some((e) => {
          const b = bookOf.get(e.excerpt_id);
          return b && (bookByUsfm(b)!.index >= 40 ? "new" : "old") !== testament;
        });
        if (!other) {
          c.group = "thematic";
          v.flags.push(`Moved from “the ${testament === "old" ? "New" : "Old"} Testament says so”: no passage from it was cited.`);
        }
      }
      if ((c.section === "history" || c.section === "culture") && !c.evidence.length) {
        v.status_source = "not_applicable";
        c.limitation = c.limitation ?? "General background; not from a cited source.";
      }
      const tKey = `t:${c.section}:${normalize(c.title).text}`;
      const qKeys = v.evidence.filter((e) => e.use === "quote" && e.quote_text && e.match !== "not_found").map((e) => `q:${normalize(e.quote_text!).text}`);
      if (seenKeys.has(tKey) || (qKeys.length && qKeys.every((k) => seenKeys.has(k)))) continue; // already in the brief
      seenKeys.add(tKey);
      qKeys.forEach((k) => seenKeys.add(k));
      kept.push({ c, v, data });
    }
    const LEGACY_TYPE: Record<string, string> = { scripture: "connection", christ: "connection", language: "history_language", history: "history_language", culture: "history_language", commentary: "commentary", tradition: "commentary" };
    db.transaction(() => {
      const insCard = db.prepare(
        `INSERT INTO cards (id, run_id, study_id, type, title, body, body_model, relationship, author_id, author_name, limitation, disagreement, priority, visible_by_default,
          status_source, status_quote, flags_json, section, group_label, data_json, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      );
      const insEv = db.prepare("INSERT INTO card_evidence (id, card_id, excerpt_id, use, quote_text, match, match_start, match_end, near_match) VALUES (?,?,?,?,?,?,?,?,?)");
      for (const { c, v, data } of kept) {
        const id = uuidv7();
        const a = c.author ? authors.find((x) => x.display_name.toLowerCase() === c.author!.toLowerCase()) : null;
        insCard.run(id, runId, study.id, LEGACY_TYPE[c.section] ?? "context", c.title, v.body, c.body, v.relationship, a?.id ?? null, c.author, c.limitation, c.disagreement, c.priority, 1,
          v.status_source, v.status_quote, JSON.stringify(v.flags), c.section, c.group, JSON.stringify(data), nowIso());
        for (const e of distinctEvidence(v.evidence)) insEv.run(uuidv7(), id, e.excerpt_id, e.use, e.quote_text, e.match, e.match_start, e.match_end, e.near_match);
        if (v.status_quote === "dequoted") dequoted++;
        else if (v.status_quote === "matched" || v.status_quote === "matched_compiled") matched++;
        indexEntity(db, "card", id, study.id, c.title, `${c.author ?? ""} ${v.body}`);
      }
    })();
    briefCards += kept.length;
    return kept.length;
  };
  const mergeBrief = (patch: Record<string, unknown>) => {
    const cur = json<Record<string, unknown>>((db.prepare("SELECT brief_json FROM research_runs WHERE id = ?").get(runId) as any).brief_json, {});
    db.prepare("UPDATE research_runs SET brief_json = ? WHERE id = ?").run(JSON.stringify({ ...cur, ...patch }), runId);
  };
  const prose = (s: string) => toReader(dequoteProse(s, excerptMap));

  const modelGaps: { author: string; note: string }[] = [];
  const brief = async <T,>(key: BriefKey, stage: "brief_scripture" | "brief_background" | "brief_voices", user: string, schema: Record<string, unknown>, onDone: (out: T) => string) => {
    if (!needs(key)) return set(key, { status: "skipped", detail: "Already in your brief" });
    set(key, { status: "running" });
    try {
      const res = await callStructured<T>({ db, stage, promptVersion: VERSIONS[stage], system: researchSystemPrompt(), user, schema, effort: "medium", maxTokens: 32000, studyId: study.id, runId, signal });
      if (stages.V.status === "queued") set("V", { status: "running" });
      set(key, { status: "done", detail: onDone(res.data) });
    } catch (e) {
      const msg = e instanceof BudgetError || e instanceof ModelError ? e.message : friendly(e);
      set(key, { status: e instanceof BudgetError ? "skipped" : "failed", error: msg });
      throw e;
    }
  };
  const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const calls = await Promise.allSettled([
    brief<ScriptureBriefOutput>("SA", "brief_scripture", scriptureBriefPrompt({ ...base, excerpts: evidenceFor("scripture") }), SCRIPTURE_BRIEF_SCHEMA, (out) => {
      const n = storeCards(out.cards.filter((c) => c.section === "scripture" || c.section === "christ").slice(0, deeper ? 9 : 12));
      db.transaction(() => {
        if (!deeper || !(db.prepare("SELECT unit_label FROM studies WHERE id = ?").get(study.id) as any)?.unit_label) {
          db.prepare("UPDATE studies SET unit_ref = ?, unit_label = ?, updated_at = ? WHERE id = ?").run(`${out.literary_unit.start}-${out.literary_unit.end}`, out.literary_unit.label, nowIso(), study.id);
        }
        db.prepare("UPDATE research_runs SET context_summary = ?, qualification = ?, writer_questions_json = ? WHERE id = ?").run(prose(out.context_summary), prose(out.qualification), JSON.stringify(out.writer_questions.slice(0, 3)), runId);
        const where = Object.fromEntries(Object.entries(out.where).map(([k, v]) => [k, prose(v ?? "")]));
        mergeBrief({ where: Object.values(where).some(Boolean) ? where : null, christ_summary: prose(out.christ_summary) });
      })();
      return count(n, "item");
    }),
    brief<BackgroundBriefOutput>("SB", "brief_background", backgroundBriefPrompt({ ...base, excerpts: evidenceFor("background") }), BACKGROUND_BRIEF_SCHEMA, (out) => {
      const n = storeCards(out.cards.filter((c) => ["language", "history", "culture"].includes(c.section)).slice(0, deeper ? 7 : 10));
      return count(n, "item");
    }),
    (async () => {
      if (!needs("SC")) return brief("SC", "brief_voices", "", {}, () => "");
      let first: VoicesBriefOutput | null = null;
      await brief<VoicesBriefOutput>("SC", "brief_voices", voicesBriefPrompt({ ...base, excerpts: evidenceFor("voices") }), VOICES_BRIEF_SCHEMA, (out) => {
        first = out;
        const n = storeCards(out.cards.filter((c) => c.section === "commentary" || c.section === "tradition").slice(0, deeper ? 8 : 12));
        modelGaps.push(...out.gaps);
        return count(n, "item");
      });
      // Every preferred voice in the evidence gets an item or an honest gap; ask again for any the first pass skipped.
      const covered = new Set([...(first!.cards ?? []).map((c) => c.author ?? ""), ...first!.gaps.map((g) => g.author)].map((n) => n.toLowerCase()));
      const missing = base.presentVoices.filter((n) => !covered.has(n.toLowerCase()));
      if (!missing.length || deeper || signal.aborted) return;
      const excerpts = rendered.filter((r) => r.kind === "bible_text" || missing.includes(r.author)).map((r) => r.text).join("\n\n");
      await brief<VoicesBriefOutput>("SC", "brief_voices", voicesBriefPrompt({ ...base, excerpts, onlyVoices: missing }), VOICES_BRIEF_SCHEMA, (out) => {
        storeCards(out.cards.filter((c) => c.section === "commentary" && c.author && missing.some((m) => m.toLowerCase() === c.author!.toLowerCase())));
        modelGaps.push(...out.gaps.filter((g) => missing.some((m) => m.toLowerCase() === g.author.toLowerCase())));
        const n = (db.prepare("SELECT COUNT(*) n FROM cards WHERE run_id = ? AND section IN ('commentary','tradition')").get(runId) as any).n;
        return count(n, "item");
      });
    })(),
  ]);
  storeGaps(db, runId, [...gaps, ...modelGaps]);
  if (signal.aborted) return finish(db, runId, "cancelled", null);
  const failures = calls.filter((c) => c.status === "rejected") as PromiseRejectedResult[];
  set("V", briefCards || !failures.length ? { status: "done", detail: `Quotes checked: ${matched} matched${dequoted ? `, ${dequoted} changed to paraphrase` : ""}` } : { status: "skipped" });
  if (failures.length === calls.length) {
    const e = failures[0].reason;
    return finish(db, runId, "partial", e instanceof BudgetError || e instanceof ModelError ? e.message : friendly(e), startedAt, study.id);
  }
  const anyFailed = Object.values(stages).some((s) => s.status === "failed");
  finish(db, runId, anyFailed || failures.length ? "partial" : "succeeded", failures.length ? "Part of the brief didn't finish. The rest is saved here; Finish the brief fills in only what's missing." : null, startedAt, study.id);
}

/** One row per thing an item rests on: an excerpt cited both as support and for a quotation is one citation, the quotation. */
export function distinctEvidence<T extends { excerpt_id: string; use: string; quote_text: string | null }>(rows: T[]): T[] {
  const quoted = new Set(rows.filter((r) => r.use === "quote" && r.quote_text).map((r) => r.excerpt_id));
  const seen = new Set<string>();
  return rows.filter((r) => {
    if (quoted.has(r.excerpt_id) && !(r.use === "quote" && r.quote_text)) return false;
    const k = `${r.excerpt_id}|${r.use}|${r.quote_text ?? ""}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function storeGaps(db: DB, runId: string, gaps: { author: string; note: string }[]) {
  const ins = db.prepare("INSERT INTO gaps (id, run_id, author_name, note, created_at) VALUES (?,?,?,?,?)");
  const seen = new Set<string>();
  for (const g of gaps) {
    const k = g.author + g.note;
    if (seen.has(k)) continue;
    seen.add(k);
    ins.run(uuidv7(), runId, g.author, g.note, nowIso());
  }
}

function finish(db: DB, runId: string, status: string, error: string | null, startedAt?: number, studyId?: string) {
  if (status === "succeeded" || status === "partial") db.prepare("UPDATE research_runs SET evidence_fingerprint = ? WHERE id = ?").run(researchEvidenceFingerprint(db, runId), runId);
  db.prepare("UPDATE research_runs SET status = ?, error = COALESCE(?, error), finished_at = ? WHERE id = ?").run(status, error, nowIso(), runId);
  const run = db.prepare("SELECT trigger, queued_at, study_id FROM research_runs WHERE id = ?").get(runId) as any;
  if (run?.trigger === "manual" && startedAt) {
    const wait = Math.round((Date.now() - Date.parse(run.queued_at)) / 1000);
    db.prepare(
      "INSERT INTO activity (study_id, local_date, research_wait_seconds) VALUES (?, date('now','localtime'), ?) ON CONFLICT(study_id, local_date) DO UPDATE SET research_wait_seconds = research_wait_seconds + excluded.research_wait_seconds",
    ).run(run.study_id, wait);
  }
  emit("run", { runId, studyId: studyId ?? run?.study_id, status });
}

/** "The user's Eden question" → "your Eden question". Other mentions of the user are left for the reader to see. */
export function toReader(text: string): string {
  return text.replace(/\b[Tt]he user[’']s\b/g, "your");
}

function unitHint(r: Range): string {
  const b = bookByUsfm(r.book)!;
  return `${b.name} ${r.c1}${r.c2 !== r.c1 ? `–${r.c2}` : ""} (the surrounding chapter)`;
}

function titleCase(s: string) {
  if (s !== s.toUpperCase()) return s;
  return s.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase()).replace(/\b(Of|On|The|And|In|To|A)\b/g, (m, _p, off) => (off === 0 ? m : m.toLowerCase()));
}

function friendly(e: unknown): string {
  if (e instanceof Error) {
    return e.message;
  }
  return String(e);
}

export type { ExcerptRow, PassageRange };
