// Find my angle, Draft, and Sharpen. The user is the author: a draft follows their notes when they have written any,
// and otherwise the findings they highlighted and the research.
import type { DB } from "./db.ts";
import { uuidv7, nowIso, json, sha256, indexEntity } from "./db.ts";
import { getPrefs } from "./prefs.ts";
import { callStructured } from "./llm.ts";
import {
  systemPrompt, anglePrompt, ANGLE_SCHEMA, allusionsPrompt, ALLUSIONS_SCHEMA, draftPrompt, DRAFT_SCHEMA, sharpenPrompt, SHARPEN_SCHEMA, titlePrompt, TITLE_SCHEMA, VERSIONS,
  type AngleOutput, type AllusionsOutput, type DraftOutput, type SharpenOutput, type TitleOutput,
} from "./prompts.ts";
import { getChapter, getPassage, versesToText, expandRange } from "./bible.ts";
import { fromUsfm, displayUsfm, displayRef, parseReference, toUsfm } from "../shared/refs.ts";
import { ownWordCount, gatingForm, findQuotations } from "../shared/text.ts";
import { getSecret } from "./secrets.ts";
import { log } from "./log.ts";
import { countPost } from "../shared/counting.ts";
import { isXFormat, WRITING_LABELS, type WritingFormat, type RefinementMode } from "../shared/writing.ts";
import { HttpError } from "./errors.ts";
import { baseRun, HIDDEN_CARD_SQL } from "./pipeline.ts";

/** The user's notebook as one text. Studies are one notebook since migration 012; first_observation is only ever set by an older client. */
export function studyNotes(study: { first_observation?: string | null; note?: string | null }): string {
  return [study.first_observation, study.note].filter((x) => x?.trim()).map((x) => x!.trim()).join("\n\n");
}

/** The user's own words in their notebook, without the lines they kept from the Bible or the research. */
export function notesWords(study: { first_observation?: string | null; note?: string | null }) {
  return ownWordCount(studyNotes(study));
}

export async function passageTextFor(db: DB, study: any): Promise<string> {
  const prefs = getPrefs(db);
  const r = fromUsfm(study.primary_ref)! as any;
  const vs = await getPassage({ id: study.translation_id }, r);
  return versesToText(vs);
}

/** The surrounding chapter (up to 20 verses either side), so claims the user rests on nearby verses can be recognized. */
export async function contextTextFor(study: any): Promise<string> {
  const r = fromUsfm(study.primary_ref)! as any;
  const vs: any[] = [];
  for (let c = r.c1; c <= r.c2; c++) {
    const ch = await getChapter({ id: study.translation_id }, r.book, c);
    for (const v of ch.verses) {
      const before = c === r.c1 ? r.v1 - v.n : 0;
      const after = c === r.c2 ? v.n - r.v2 : 0;
      if (before <= 20 && after <= 20) vs.push({ chapter: c, n: v.n, text: v.text });
    }
  }
  return versesToText(vs);
}

/** Cards serialized for drafting and review. Only matched quotations are marked quotable. */
export function cardsForModel(db: DB, cardIds: string[]) {
  const labels = new Map<string, string>();
  const out = cardIds.map((id, i) => {
    const c = db.prepare("SELECT * FROM cards WHERE id = ?").get(id) as any;
    const ev = db
      .prepare(
        `SELECT ce.use, ce.quote_text, ce.match, e.short_id, e.text AS excerpt, s.title AS source_title, s.url, s.rights
           FROM card_evidence ce JOIN excerpts e ON e.id = ce.excerpt_id JOIN sources s ON s.id = e.source_id WHERE ce.card_id = ?`,
      )
      .all(id) as any[];
    const label = `card_${i + 1}`;
    labels.set(label, id);
    return {
      card_id: label,
      title: c.title,
      body: c.body,
      author: c.author_name,
      relationship: c.relationship,
      statuses: { source: c.status_source, quote: c.status_quote, interpretation: c.status_interpretation },
      limitation: c.limitation,
      evidence: ev.map((e) => ({
        excerpt_id: e.short_id,
        source: e.source_title,
        url: e.url,
        use: e.use,
        quotable_words: e.use === "quote" && e.match && e.match !== "not_found" ? e.quote_text : null,
        excerpt: e.excerpt.length > 1200 ? e.excerpt.slice(0, 1200) + "…" : e.excerpt,
      })),
    };
  });
  return { cards: out, labels };
}

export function selectedCardIds(db: DB, studyId: string): string[] {
  return (db.prepare("SELECT id FROM cards WHERE study_id = ? AND selected = 1 AND status_interpretation != 'disputed' ORDER BY priority").all(studyId) as any[]).map((r) => r.id);
}

const SECTION_ORDER = ["where", "scripture", "christ", "language", "history", "culture", "commentary", "tradition"];
const LEGACY_SECTION: Record<string, string> = { connection: "scripture", commentary: "commentary", history_language: "history", context: "where", another_reading: "tradition", question: "where" };
export const sectionOf = (c: { section?: string | null; type: string; author_name?: string | null }) => c.section ?? (c.type === "commentary" && !c.author_name ? "where" : LEGACY_SECTION[c.type] ?? "where");

/** The current brief: the latest standard run and any Go deeper after it, plus anything the user marked from earlier research. */
export function currentBriefCards(db: DB, studyId: string): any[] {
  const all = db.prepare(`SELECT * FROM cards WHERE study_id = ? AND status_interpretation != 'disputed' AND NOT (${HIDDEN_CARD_SQL}) ORDER BY run_id, priority, created_at`).all(studyId) as any[];
  const base = baseRun(db, studyId);
  const cur = all.filter((c) => !base || c.run_id >= base.id || c.selected);
  return cur.sort((a, b) => SECTION_ORDER.indexOf(sectionOf(a)) - SECTION_ORDER.indexOf(sectionOf(b)) || a.priority - b.priority);
}

/** The brief, compact, labeled item_1…: what drafting and Find my angle may draw on. Pinned items carry their full evidence. */
export function briefForModel(db: DB, studyId: string) {
  const cards = currentBriefCards(db, studyId);
  const labels = new Map<string, string>();
  const quotable = db.prepare("SELECT ce.quote_text FROM card_evidence ce WHERE ce.card_id = ? AND ce.use = 'quote' AND ce.match IN ('exact','loose','elided')");
  const items = cards.map((c, i) => {
    const label = `item_${i + 1}`;
    labels.set(label, c.id);
    const data = json<any>(c.data_json, {});
    return {
      item: label, section: sectionOf(c), group: c.group_label, title: c.title, body: c.body, author: c.author_name, stood_out: !!c.selected,
      quotable_words: (quotable.all(c.id) as any[]).map((r) => r.quote_text),
      ...(data.strong ? { word: { lemma: data.lemma, translit: data.translit, strong: data.strong, gloss: data.gloss, in_verse: data.in_verse?.gloss, uses: data.count } } : {}),
    };
  });
  const pinnedIds = cards.filter((c) => c.selected).map((c) => c.id);
  const labelOf = new Map([...labels].map(([l, id]) => [id, l]));
  const pinned = cardsForModel(db, pinnedIds).cards.map((p, i) => ({ ...p, card_id: labelOf.get(pinnedIds[i])! }));
  return { items, pinned, labels, pinnedIds };
}

/** The Bible passages the user's notes quote or allude to, with their text — support for their claims beyond this chapter. Cached by the notes' text. */
export async function scriptureDrawnOn(db: DB, study: any): Promise<DrawnOn[]> {
  const notes = studyNotes(study);
  if (!notes) return [];
  const hash = sha256(notes);
  if (study.allusions_hash === hash) return json(study.allusions_json, []);
  if (!getSecret("openai_api_key")) return [];
  try {
    const res = await callStructured<AllusionsOutput>({
      db, stage: "allusions", promptVersion: VERSIONS.allusions, system: systemPrompt(getPrefs(db)), user: allusionsPrompt({ displayRef: study.display_ref, notes }),
      schema: ALLUSIONS_SCHEMA, effort: "low", maxTokens: 3000, studyId: study.id,
    });
    const out: DrawnOn[] = [];
    for (const a of res.data.allusions.slice(0, 8)) {
      const p = parseReference(a.usfm);
      const r = fromUsfm(a.usfm.trim().toUpperCase()) ?? (p.ok ? p.range : null);
      if (!r) continue;
      const e = expandRange(r);
      if (!e.ok || e.range.c2 - e.range.c1 > 1) continue;
      try {
        const vs = await getPassage({ id: study.translation_id }, e.range);
        if (vs.length && vs.length <= 6) out.push({ usfm: toUsfm(e.range), label: displayRef(e.range), phrase: a.phrase, translation_note: a.translation_note, text: versesToText(vs, vs.length > 1) });
      } catch {
        /* not in this translation's numbering */
      }
    }
    db.prepare("UPDATE studies SET allusions_json = ?, allusions_hash = ? WHERE id = ?").run(JSON.stringify(out), hash, study.id);
    return out;
  } catch (e) {
    log("warn", "writing", "allusions_failed", { studyId: study.id, error: String(e) });
    return [];
  }
}
export interface DrawnOn {
  usfm: string;
  label: string;
  phrase: string;
  translation_note: string | null;
  text: string;
}

export function drawnOnText(list: DrawnOn[], translation: string) {
  return list
    .map((a) => `${a.label} — ${a.text}\n  (The user's phrase: "${a.phrase}"${a.translation_note ? `; ${a.translation_note}; quote the ${translation} words above, not their wording` : ""})`)
    .join("\n");
}

/** Find my angle: three ways into a post, each resting on one item of the brief, each ending in a question only the user can answer. Never prose. */
export async function findAngles(db: DB, studyId: string, previous: string[] = []) {
  const study = db.prepare("SELECT * FROM studies WHERE id = ?").get(studyId) as any;
  const prefs = getPrefs(db);
  const { items, labels } = briefForModel(db, studyId);
  const res = await callStructured<AngleOutput>({
    db, stage: "angle", promptVersion: VERSIONS.angle, system: systemPrompt(prefs),
    user: anglePrompt({ displayRef: study.display_ref, translation: study.translation_id, passage: await passageTextFor(db, study), brief: JSON.stringify(items), notes: studyNotes(study), previous }),
    schema: ANGLE_SCHEMA, effort: "medium", maxTokens: 6000, studyId,
  });
  return {
    angles: res.data.angles.slice(0, 3).map((a) => {
      const id = labels.get(a.item.trim()) ?? null;
      const c = id ? (db.prepare("SELECT id, title, section, type, author_name FROM cards WHERE id = ?").get(id) as any) : null;
      const you = (t: string | null) => (t ? t.replace(/\b[Tt]he user[’']s\b/g, "your").replace(/\b[Tt]he user\b/g, "you") : t);
      return { ...a, finding: you(a.finding)!, why_it_lands: you(a.why_it_lands)!, meets_you: you(a.meets_you), question: you(a.question)!, card: c ? { id: c.id, title: c.title, section: sectionOf(c), author: c.author_name } : null };
    }),
  };
}

export function buildSourceReply(db: DB, study: any, cardIds: string[]): string {
  const lines = ["Sources:", `${displayUsfm(study.primary_ref)} (${study.translation_id})`];
  const seen = new Set<string>();
  for (const id of cardIds) {
    const rows = db
      .prepare(`SELECT s.title, s.url, s.kind, s.author_name, s.work, s.locator FROM card_evidence ce JOIN excerpts e ON e.id = ce.excerpt_id JOIN sources s ON s.id = e.source_id WHERE ce.card_id = ?`)
      .all(id) as any[];
    for (const s of rows) {
      if (s.kind === "bible_text") continue;
      const label = s.kind === "cross_reference" ? s.locator : s.kind === "hcf_excerpt" ? `${s.author_name}${s.work ? ", " + s.work : ""}` : s.title;
      const url = s.url && !/historicalchristian\.faith/.test(s.url) ? ` — ${s.url.replace(/^https:\/\/(www\.)?/, "")}` : "";
      const line = `${label}${url}`;
      if (seen.has(line)) continue;
      seen.add(line);
      lines.push(line);
    }
  }
  return lines.join("\n");
}

export interface WorkingText {
  format: WritingFormat;
  parts: string[];
  source_reply: string;
  text_hash: string;
  origin_draft_id: string | null;
  updated_at: string;
}

export function textHash(parts: string[], sourceReply: string, format: WritingFormat = "single") {
  return sha256((format === "single" ? "" : `${format}\n`) + gatingForm(parts, sourceReply));
}

export function getWorkingText(db: DB, studyId: string): WorkingText | null {
  const r = db.prepare("SELECT * FROM working_texts WHERE study_id = ?").get(studyId) as any;
  if (!r) return null;
  return { format: r.format, parts: json<string[]>(r.parts_json, [""]), source_reply: r.source_reply ?? "", text_hash: r.text_hash, origin_draft_id: r.origin_draft_id, updated_at: r.updated_at };
}

export function getWorkingTextVariants(db: DB, studyId: string): WorkingText[] {
  return (db.prepare("SELECT * FROM working_text_variants WHERE study_id = ? ORDER BY updated_at DESC").all(studyId) as any[])
    .map((r) => ({ format: r.format, parts: json<string[]>(r.parts_json, [""]), source_reply: r.source_reply ?? "", text_hash: r.text_hash, origin_draft_id: r.origin_draft_id, updated_at: r.updated_at }));
}

export function saveWorkingText(db: DB, studyId: string, w: { format: WritingFormat; parts: string[]; source_reply: string }, cause: string, originDraftId?: string | null): WorkingText {
  w = { ...w, parts: w.format === "thread" ? w.parts : [w.parts.join("\n\n")], source_reply: isXFormat(w.format) ? w.source_reply : "" };
  const hash = textHash(w.parts, w.source_reply, w.format);
  const now = nowIso();
  const prev = getWorkingText(db, studyId);
  db.transaction(() => {
    if (prev) storeVariant(db, studyId, prev);
    const target = db.prepare("SELECT origin_draft_id FROM working_text_variants WHERE study_id = ? AND format = ?").get(studyId, w.format) as any;
    const origin = originDraftId === undefined ? (prev?.format === w.format ? prev.origin_draft_id : target?.origin_draft_id ?? null) : originDraftId;
    db.prepare(
      `INSERT INTO working_texts (study_id, format, parts_json, source_reply, origin_draft_id, text_hash, updated_at) VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(study_id) DO UPDATE SET format = excluded.format, parts_json = excluded.parts_json, source_reply = excluded.source_reply,
         origin_draft_id = excluded.origin_draft_id, text_hash = excluded.text_hash, updated_at = excluded.updated_at`,
    ).run(studyId, w.format, JSON.stringify(w.parts), w.source_reply, origin, hash, now);
    // Append-only revisions, coalescing typing into one row per 30 s.
    const last = db.prepare("SELECT id, cause, created_at FROM text_revisions WHERE study_id = ? AND format = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(studyId, w.format) as any;
    // Before applying a suggestion or restoring history, preserve even the last uncoalesced edit.
    if (prev && prev.text_hash !== hash && cause !== "typing" && !db.prepare("SELECT 1 FROM text_revisions WHERE study_id = ? AND format = ? AND text_hash = ?").get(studyId, prev.format, prev.text_hash)) {
      db.prepare("INSERT INTO text_revisions (id, study_id, parts_json, source_reply, text_hash, cause, created_at, format) VALUES (?,?,?,?,?,?,?,?)")
        .run(uuidv7(), studyId, JSON.stringify(prev.parts), prev.source_reply, prev.text_hash, "before_change", now, prev.format);
    }
    if (cause === "typing" && prev?.format === w.format && last && last.cause === "typing" && Date.now() - Date.parse(last.created_at) < 30_000) {
      db.prepare("UPDATE text_revisions SET parts_json = ?, source_reply = ?, text_hash = ? WHERE id = ?").run(JSON.stringify(w.parts), w.source_reply, hash, last.id);
    } else if (!prev || prev.text_hash !== hash || prev.format !== w.format) {
      db.prepare("INSERT INTO text_revisions (id, study_id, parts_json, source_reply, text_hash, cause, created_at, format) VALUES (?,?,?,?,?,?,?,?)").run(uuidv7(), studyId, JSON.stringify(w.parts), w.source_reply, hash, cause, now, w.format);
    }
    storeVariant(db, studyId, getWorkingText(db, studyId)!);
    db.prepare("UPDATE studies SET format = ?, updated_at = ? WHERE id = ?").run(w.format, now, studyId);
    indexEntity(db, "post", studyId, studyId, "", getWorkingTextVariants(db, studyId).map((v) => v.parts.join("\n")).join("\n\n"));
  })();
  return getWorkingText(db, studyId)!;
}

function storeVariant(db: DB, studyId: string, w: WorkingText) {
  db.prepare(`INSERT INTO working_text_variants (study_id, format, parts_json, source_reply, origin_draft_id, text_hash, updated_at) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(study_id, format) DO UPDATE SET parts_json = excluded.parts_json, source_reply = excluded.source_reply,
      origin_draft_id = excluded.origin_draft_id, text_hash = excluded.text_hash, updated_at = excluded.updated_at`)
    .run(studyId, w.format, JSON.stringify(w.parts), w.source_reply, w.origin_draft_id, w.text_hash, w.updated_at);
}

/** Switching the writing form never converts or overwrites the other form's text. */
export function switchWritingFormat(db: DB, studyId: string, format: WritingFormat): WorkingText {
  return db.transaction(() => {
    const current = getWorkingText(db, studyId);
    if (current?.format === format) return current;
    const saved = db.prepare("SELECT * FROM working_text_variants WHERE study_id = ? AND format = ?").get(studyId, format) as any;
    return saveWorkingText(db, studyId, { format, parts: saved ? json<string[]>(saved.parts_json, [""]) : [""], source_reply: saved?.source_reply ?? "" }, "format_changed", saved?.origin_draft_id ?? null);
  })();
}

/** What the user has already written from this study in other forms (their study notes, say, before an X post), most recent first. */
export function otherPieces(db: DB, studyId: string, format: WritingFormat): { label: string; text: string }[] {
  return getWorkingTextVariants(db, studyId)
    .filter((v) => v.format !== format && !(isXFormat(v.format) && isXFormat(format)) && v.parts.some((p) => p.trim()))
    .slice(0, 3)
    .map((v) => ({ label: WRITING_LABELS[v.format], text: v.parts.filter((p) => p.trim()).join("\n\n").slice(0, 6000) }));
}

/** Share of words that differ between two texts (0 = same words, 1 = nothing kept), by word-level edit distance. */
function wordChange(a: string, b: string): number {
  const x = a.toLowerCase().match(/[\p{L}\p{N}’']+/gu) ?? [];
  const y = b.toLowerCase().match(/[\p{L}\p{N}’']+/gu) ?? [];
  if (!x.length || !y.length) return x.length === y.length ? 0 : 1;
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[y.length] / Math.max(x.length, y.length);
}

export interface VoiceSamples {
  /** X posts the user wrote or rewrote in other studies, newest first: their finished wording. */
  ownPosts: { ref: string; text: string; posted: boolean }[];
  /** Drafts they substantially rewrote: what they were offered and what they made of it. */
  edits: { ref: string; draft: string; final: string }[];
}

/**
 * The user's voice on X, learned from their own posts in other studies: what they posted, and drafts they rewrote. A draft they
 * kept word for word is the model's voice, not theirs, so it never counts.
 */
export function voiceSamples(db: DB, exceptStudyId: string | null = null, limit = 6): VoiceSamples {
  const rows = db.prepare(
    `SELECT v.study_id, v.parts_json, v.origin_draft_id, v.updated_at, s.display_ref, d.parts_json AS draft_json
       FROM working_text_variants v JOIN studies s ON s.id = v.study_id LEFT JOIN drafts d ON d.id = v.origin_draft_id
      WHERE v.format IN ('single','long','thread') AND v.study_id IS NOT ? ORDER BY v.updated_at DESC`,
  ).all(exceptStudyId) as any[];
  const postedText = db.prepare("SELECT COALESCE(published_text, text) AS t FROM posts WHERE study_id = ? AND status = 'posted' AND role IN ('main','thread_part') ORDER BY sequence");
  const ownPosts: VoiceSamples["ownPosts"] = [];
  const edits: VoiceSamples["edits"] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.study_id)) continue;
    const posted = (postedText.all(r.study_id) as any[]).map((p) => p.t.trim()).filter(Boolean);
    const text = (posted.length ? posted : json<string[]>(r.parts_json, []).map((p) => p.trim()).filter(Boolean)).join("\n\n");
    if (!text) continue;
    const draft = r.draft_json ? json<string[]>(r.draft_json, []).join("\n\n").trim() : "";
    const change = draft ? wordChange(draft, text) : 1;
    if (!posted.length && change === 0) continue;
    seen.add(r.study_id);
    ownPosts.push({ ref: r.display_ref, text, posted: posted.length > 0 });
    if (draft && change >= 0.2 && edits.length < 3) edits.push({ ref: r.display_ref, draft, final: text });
  }
  return { ownPosts: ownPosts.slice(0, limit), edits };
}

/** A short title for the study, from whatever it holds so far: the passage, the notebook, the highlights, and any piece. */
export async function suggestTitle(db: DB, studyId: string, previous: string[] = []): Promise<string> {
  const study = db.prepare("SELECT * FROM studies WHERE id = ?").get(studyId) as any;
  const highlights = (db.prepare("SELECT title FROM cards WHERE study_id = ? AND selected = 1 ORDER BY priority LIMIT 8").all(studyId) as any[]).map((c) => c.title);
  const pieces = getWorkingTextVariants(db, studyId).filter((v) => v.parts.some((p) => p.trim())).slice(0, 2)
    .map((v) => ({ label: WRITING_LABELS[v.format], text: v.parts.join("\n\n").slice(0, 3000) }));
  const brief = highlights.length || pieces.length || notesWords(study) ? [] : currentBriefCards(db, studyId).slice(0, 8).map((c) => c.title);
  const res = await callStructured<TitleOutput>({
    db, stage: "title", promptVersion: VERSIONS.title, system: systemPrompt(getPrefs(db)),
    user: titlePrompt({ displayRef: study.display_ref, passage: await passageTextFor(db, study), notes: studyNotes(study), highlights, pieces, brief, previous: [...previous, ...(study.title ? [study.title] : [])] }),
    schema: TITLE_SCHEMA, effort: "low", maxTokens: 2000, studyId,
  });
  const title = res.data.title.replace(/^["“”']+|["“”'.]+$/g, "").trim().slice(0, 120);
  if (!title) throw new HttpError(502, "No title came back. Your study is unchanged; try again, or type one yourself.");
  return title;
}

export async function draft(db: DB, studyId: string, kind: "edit" | "alternate", format: WritingFormat) {
  const study = db.prepare("SELECT * FROM studies WHERE id = ?").get(studyId) as any;
  const prefs = getPrefs(db);
  if (format === "long" && !prefs.premium) throw new HttpError(400, "Long X posts need X Premium. Your study is saved; choose an X post or thread, or enable Premium in Settings.");
  const { items, pinned, labels, pinnedIds } = briefForModel(db, studyId);
  const others = otherPieces(db, studyId, format);
  // Notes are optional, but a draft needs something to stand on besides the passage.
  if (!items.length && !notesWords(study) && !others.length)
    throw new HttpError(400, "There's nothing to draft from yet. Your study is saved; research the passage or jot a few thoughts in your notebook, then try again.");
  const drawn = await scriptureDrawnOn(db, study);
  const prev = kind === "alternate" ? (db.prepare("SELECT parts_json FROM drafts WHERE study_id = ? AND format = ? ORDER BY created_at DESC LIMIT 1").get(studyId, format) as any) : null;
  const res = await callStructured<DraftOutput>({
    db, stage: "draft", promptVersion: VERSIONS.draft, system: systemPrompt(prefs),
    user: draftPrompt({
      formatTarget: format, premium: prefs.premium, translation: study.translation_id, displayRef: study.display_ref, passage: await passageTextFor(db, study), context: await contextTextFor(study),
      pinned: pinned.length ? JSON.stringify(pinned) : "", brief: JSON.stringify(items.filter((i) => !i.stood_out)), drawsOn: drawnOnText(drawn, study.translation_id),
      notes: studyNotes(study), question: study.question, voice: prefs.voicePrinciples, banned: prefs.bannedPhrases,
      examples: prefs.approvedExamples.slice(0, 6), ...(isXFormat(format) ? voiceSamples(db, studyId) : { ownPosts: [], edits: [] }),
      previousParts: prev ? json<string[]>(prev.parts_json, []) : null, otherPieces: others,
    }),
    schema: DRAFT_SCHEMA, effort: "medium", maxTokens: 12000, studyId,
  });
  const d = res.data;
  let parts = d.parts.map((p) => p.replace(/[ \t]+$/gm, "").replace(/\n{4,}/g, "\n\n\n").trim()).filter(Boolean);
  if (!parts.length) throw new HttpError(502, "The first draft came back empty. Your thoughts and research are saved; try drafting again.");
  if (format !== "thread") parts = [parts.join("\n\n")];
  const outFormat: WritingFormat = format;
  const notes: string[] = [];
  if (d.notes_for_writer) notes.push(d.notes_for_writer);
  if (isXFormat(format) && parts[0] && d.hook && parts[0].split("\n")[0].trim() !== d.hook.trim()) notes.push("Check the opening: the suggested first line differs from the draft.");
  for (const p of isXFormat(outFormat) ? parts : []) {
    const c = countPost(p, outFormat === "long" ? "long" : "single");
    if (c.over) notes.push(`A part is ${c.weightedLength} characters (limit ${c.limit}).`);
  }
  const claimMap = d.claim_map.map((m) => ({ ...m, card_id: m.card_id ? labels.get(m.card_id) ?? null : null }));
  const drewOn = d.drew_on
    .map((x) => ({ id: labels.get(x.item.trim()), why: x.why }))
    .filter((x): x is { id: string; why: string } => !!x.id)
    .map((x) => {
      const c = db.prepare("SELECT title, author_name, section, type FROM cards WHERE id = ?").get(x.id) as any;
      return { card_id: x.id, title: c.title, author: c.author_name, section: sectionOf(c), why: x.why };
    });
  const usedIds = [...new Set([...pinnedIds, ...drewOn.map((x) => x.card_id)])];
  const sourceReply = isXFormat(format) ? d.source_reply?.trim() || buildSourceReply(db, study, usedIds) : "";
  const firstLine = parts[0]?.split("\n")[0].trim() ?? "";
  const extras = {
    drew_on: drewOn,
    left_out: d.left_out.slice(0, 4),
    alternate_openings: d.alternate_openings.map((o) => o.trim()).filter((o) => o && o !== firstLine).slice(0, 3),
    drawn_on_scripture: drawn.map((a) => ({ label: a.label, phrase: a.phrase, translation_note: a.translation_note })),
  };
  // An untitled study takes its title from its first draft; you can rename it, or ask for another, at any time.
  const title = d.title?.replace(/^["“”']+|["“”'.]+$/g, "").trim();
  if (title && !study.title?.trim()) db.prepare("UPDATE studies SET title = ?, title_auto = 1 WHERE id = ? AND (title IS NULL OR trim(title) = '')").run(title.slice(0, 120), studyId);
  const id = uuidv7();
  db.prepare(
    `INSERT INTO drafts (id, study_id, kind, format, parts_json, hook, source_reply, changes_json, claim_map_json, notes_for_writer, card_ids_json, note_snapshot, llm_call_id, created_at, extras_json)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(id, studyId, kind, outFormat, JSON.stringify(parts), d.hook, sourceReply, "[]", JSON.stringify(claimMap), notes.join(" "), JSON.stringify(usedIds),
    studyNotes(study), res.callId, nowIso(), JSON.stringify(extras));
  return getDraft(db, id);
}

export function getDraft(db: DB, id: string) {
  const r = db.prepare("SELECT * FROM drafts WHERE id = ?").get(id) as any;
  if (!r) throw new HttpError(404, "That draft couldn't be found. Your study is saved; reopen its writing tools.");
  return {
    id: r.id, kind: r.kind, format: r.format, parts: json<string[]>(r.parts_json, []), hook: r.hook, source_reply: r.source_reply,
    changes: json<any[]>(r.changes_json, []), claim_map: json<any[]>(r.claim_map_json, []), notes_for_writer: r.notes_for_writer,
    note_snapshot: r.note_snapshot, created_at: r.created_at, card_ids: json<string[]>(r.card_ids_json, []),
    ...json<{ drew_on?: any[]; left_out?: any[]; alternate_openings?: string[]; drawn_on_scripture?: any[] }>(r.extras_json, {}),
  };
}

export interface SharpenChange {
  part_index: number;
  kind: string;
  before: string;
  after: string;
  reason: string;
  /** The change can be accepted on its own: its "before" text appears exactly once in that part. */
  separable: boolean;
}

/**
 * Sharpen: an editor's pass over a post the user wrote (grammar, tightness, first line, flow, length).
 * Words inside quotation marks never change; a part whose quotations didn't survive keeps the user's text.
 */
export async function sharpen(db: DB, studyId: string, options: { mode?: RefinementMode; instruction?: string } = {}) {
  const study = db.prepare("SELECT * FROM studies WHERE id = ?").get(studyId) as any;
  const w = getWorkingText(db, studyId);
  if (!w || !w.parts.some((p) => p.trim())) throw new HttpError(400, "There isn't a draft to refine yet. Your study is saved; write or create a first draft.");
  const prefs = getPrefs(db);
  const limit = !isXFormat(w.format) ? null : w.format === "long" && prefs.premium ? 25_000 : 280;
  const res = await callStructured<SharpenOutput>({
    db, stage: "sharpen", promptVersion: VERSIONS.sharpen, system: systemPrompt(prefs),
    user: sharpenPrompt({ parts: w.parts, format: w.format, limit, premium: prefs.premium, voice: prefs.voicePrinciples, banned: prefs.bannedPhrases, translation: study.translation_id, mode: options.mode ?? "polish", instruction: options.instruction,
      ...(isXFormat(w.format) ? { examples: prefs.approvedExamples.slice(0, 6), ...voiceSamples(db, studyId) } : {}) }),
    schema: SHARPEN_SCHEMA, effort: "medium", maxTokens: 8000, studyId,
  });
  const notes: string[] = [];
  if (res.data.note) notes.push(res.data.note);
  let parts = res.data.parts.map((p) => p.replace(/[ \t]+$/gm, "").trim());
  // A different number of parts can't be compared edit by edit; keep the part structure the user has.
  if (parts.length !== w.parts.length) parts = w.parts.map((p, i) => parts[i] ?? p);
  const kept = new Set<number>();
  let protectedQuotes = 0;
  parts = parts.map((p, i) => {
    const original = w.parts[i];
    if (!p.trim() && original.trim()) {
      kept.add(i);
      notes.push("An empty edit was skipped; your text was kept.");
      return original;
    }
    const originalQuotes = findQuotations(original).map((q) => q.inner.trim());
    const editedQuotes = findQuotations(p).map((q) => q.inner.trim());
    const lost = originalQuotes.length !== editedQuotes.length || originalQuotes.some((q, qi) => q !== editedQuotes[qi]);
    if (lost) {
      kept.add(i);
      protectedQuotes++;
      return original;
    }
    return p;
  });
  if (protectedQuotes) notes.push("Quotations stay exactly as you wrote them, so part of the draft was left unchanged.");
  for (const p of isXFormat(w.format) ? parts : []) {
    const c = countPost(p, w.format === "long" ? "long" : "single");
    if (c.over) notes.push(`A part is still ${c.weightedLength} characters (limit ${c.limit}).`);
  }
  const changes: SharpenChange[] = res.data.changes
    .filter((c) => !kept.has(c.part_index) && w.parts[c.part_index] !== undefined && c.before !== c.after)
    .map((c) => {
      const src = w.parts[c.part_index];
      const first = c.before ? src.indexOf(c.before) : -1;
      return { ...c, separable: first >= 0 && src.indexOf(c.before, first + 1) < 0 && parts[c.part_index].includes(c.after) };
    });
  const unchanged = parts.every((p, i) => p === w.parts[i]);
  return { base_hash: w.text_hash, original: w.parts, parts, changes, unchanged, notes: notes.join(" ") };
}

/** Deterministic thread split at sentence boundaries: ≤280 per part, ≤4 parts, never inside quotes or a reference (§17.4). */
export function splitIntoThread(text: string): string[] | null {
  const sentences: string[] = [];
  let buf = "";
  let inQuote = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    buf += ch;
    if (ch === "“") inQuote = true;
    else if (ch === "”") inQuote = false;
    else if (ch === '"') inQuote = !inQuote;
    const next = text[i + 1];
    const isEnd = /[.!?]/.test(ch) && (next === undefined || /\s/.test(next)) && !inQuote;
    const isPara = ch === "\n" && next === "\n";
    if ((isEnd || isPara) && !/\b\d+:\d*$/.test(buf)) {
      sentences.push(buf.trim());
      buf = "";
    }
  }
  if (buf.trim()) sentences.push(buf.trim());
  const parts: string[] = [];
  let cur = "";
  for (const s of sentences.filter(Boolean)) {
    const candidate = cur ? `${cur} ${s}` : s;
    if (countPost(candidate).weightedLength <= 280) cur = candidate;
    else {
      if (!cur) return null; // one sentence is longer than 280
      parts.push(cur);
      cur = s;
      if (countPost(cur).weightedLength > 280) return null;
    }
  }
  if (cur) parts.push(cur);
  return parts.length <= 4 ? parts : null;
}
