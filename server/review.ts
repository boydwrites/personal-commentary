// Review: deterministic checks D1–D14 on every save, the model review on demand, and the publish gate.
import type { DB } from "./db.ts";
import { uuidv7, nowIso, json } from "./db.ts";
import { getPrefs, type Preferences } from "./prefs.ts";
import { countPost, findEntities, type PostFormat } from "../shared/counting.ts";
import { isXFormat } from "../shared/writing.ts";
import { findQuotations, matchQuotation, normalize, loose, trigrams, jaccard, words } from "../shared/text.ts";
import { findReferencesInText, bookByUsfm, fromUsfm, displayRef, parseReference, toUsfm } from "../shared/refs.ts";
import { getChapter, expandRange } from "./bible.ts";
import { WATCHLIST } from "./seed.ts";
import { HttpError } from "./errors.ts";
import { callStructured } from "./llm.ts";
import { systemPrompt, reviewPrompt, REVIEW_SCHEMA, VERSIONS, type ReviewOutput } from "./prompts.ts";
import { getWorkingText, cardsForModel, selectedCardIds, passageTextFor, contextTextFor, textHash, scriptureDrawnOn, drawnOnText, type WorkingText } from "./writing.ts";

export type Severity = "blocker" | "judgment" | "suggestion";
export interface Finding {
  key: string;
  id?: string; // model findings have a DB id
  source: "deterministic" | "model";
  code: string;
  name: string;
  severity: Severity;
  part_index: number; // -1 = source reply
  start: number | null;
  end: number | null;
  span_text: string | null;
  problem: string;
  repair: string | null;
  repair_label?: string;
  support?: { ref: string; display: string; text: string }[];
  resolution?: string | null;
  resolution_reason?: string | null;
}

// ---------- Scripture corpus ----------

async function scriptureCorpus(db: DB, study: any, texts: string[]): Promise<{ id: string; label: string; text: string }[]> {
  const prefs = getPrefs(db);
  const t = { id: study.translation_id };
  const chapters = new Set<string>();
  const r = fromUsfm(study.primary_ref)!;
  for (let c = r.c1; c <= r.c2; c++) chapters.add(`${r.book}.${c}`);
  for (const tx of texts) for (const ref of findReferencesInText(tx, r.book)) for (let c = ref.range.c1; c <= ref.range.c2; c++) chapters.add(`${ref.range.book}.${c}`);
  // Scripture the user's notes draw on counts too, even when the post doesn't name the reference.
  for (const a of json<{ usfm: string }[]>(study.allusions_json, [])) {
    const ar = fromUsfm(a.usfm);
    if (ar) for (let c = ar.c1; c <= ar.c2; c++) chapters.add(`${ar.book}.${c}`);
  }
  const out: { id: string; label: string; text: string }[] = [];
  let fetches = 0;
  for (const key of chapters) {
    if (fetches++ >= 16) break;
    const [book, ch] = key.split(".");
    try {
      const chapter = await getChapter(t, book, +ch);
      for (const v of chapter.verses) out.push({ id: v.id, label: `${bookByUsfm(book)!.name} ${ch}:${v.n}`, text: v.text });
    } catch {
      /* unknown chapter — the reference check reports it */
    }
  }
  // Cross-reference texts from this study's research also count as Scripture.
  const xr = db
    .prepare(`SELECT DISTINCT s.text, s.locator FROM sources s JOIN run_sources rs ON rs.source_id = s.id JOIN research_runs r ON r.id = rs.run_id WHERE r.study_id = ? AND s.kind = 'cross_reference'`)
    .all(study.id) as any[];
  for (const x of xr) out.push({ id: x.locator, label: x.locator, text: x.text.replace(/\[\d+:\d+\]\s?/g, "") });
  // Word studies list other verses that use the word; their text is Scripture too.
  const lex = db
    .prepare(`SELECT DISTINCT s.text FROM sources s JOIN run_sources rs ON rs.source_id = s.id JOIN research_runs r ON r.id = rs.run_id WHERE r.study_id = ? AND s.kind = 'lexicon_entry'`)
    .all(study.id) as any[];
  for (const x of lex) {
    const tail = (x.text as string).split(/\nUsed \d+ times?[^\n]*\n?/)[1] ?? "";
    for (const line of tail.split("\n")) {
      const m = /^(.+?) — (.+)$/.exec(line);
      if (m) out.push({ id: m[1], label: m[1], text: m[2] });
    }
  }
  return out;
}

function matchScripture(inner: string, corpus: { label: string; text: string }[]): { label: string } | null {
  const q = loose(inner).text;
  if (q.length < 3) return null;
  // Quotations can span verse boundaries: try single verses, then joined runs.
  for (const v of corpus) if (loose(v.text).text.includes(q)) return { label: v.label };
  const joined = loose(corpus.map((v) => v.text).join(" ")).text;
  return joined.includes(q) ? { label: "Scripture" } : null;
}

// ---------- Deterministic checks ----------

const PLACEHOLDER = /\((?:[^)]*\b(?:link|tag|tk|todo|cite|ref)\b[^)]*)\)?|\bTODO\b|\bTK\b|\[ \]|<[^<>\n]{1,40}>|\blorem\b|\?\?\?|\[(?:insert|add|link|cite)[^\]]*\]/gi;
const CONTRAST = /\b(it'?s|this is|that'?s)\s+not\s+(just\s+)?[^.?!]{1,60}[,;—-]\s*(it'?s|but)\b/gi;

export async function deterministicReview(db: DB, studyId: string, w: WorkingText): Promise<Finding[]> {
  const study = db.prepare("SELECT * FROM studies WHERE id = ?").get(studyId) as any;
  const prefs = getPrefs(db);
  const findings: Finding[] = [];
  const xFormat = isXFormat(w.format);
  const all = [...w.parts.map((p, i) => ({ text: p, index: i })), { text: w.source_reply ?? "", index: -1 }];
  const corpus = await scriptureCorpus(db, study, all.map((x) => x.text));

  // Stored source texts and matched card quotations for this study.
  const sourceTexts = (db
    .prepare(`SELECT DISTINCT s.id, s.text, s.match_level FROM sources s JOIN run_sources rs ON rs.source_id = s.id JOIN research_runs r ON r.id = rs.run_id WHERE r.study_id = ? AND s.text IS NOT NULL`)
    .all(studyId) as any[]);
  const matchedCardQuotes = (db
    .prepare(`SELECT ce.quote_text FROM card_evidence ce JOIN cards c ON c.id = ce.card_id WHERE c.study_id = ? AND ce.use = 'quote' AND ce.match IN ('exact','loose','elided')`)
    .all(studyId) as any[]).map((r) => r.quote_text as string);

  const add = (f: Omit<Finding, "key" | "source">) => findings.push({ ...f, source: "deterministic", key: `${f.code}:${f.part_index}:${f.span_text ?? ""}` });

  if (xFormat) w.parts.forEach((text, index) => {
    const fmt: PostFormat = w.format === "long" ? "long" : "single";
    const c = countPost(text, fmt);
    if (c.over) {
      add({ code: "D1", name: "length_over", severity: "blocker", part_index: index, start: null, end: null, span_text: null,
        problem: `${c.weightedLength} of ${c.limit} characters${!prefs.premium && w.format !== "long" ? " for a standard account" : ""}.`,
        repair: null, repair_label: "Split into a thread, or trim" });
    }
  });
  if (w.format === "long" && !prefs.premium) {
    add({ code: "D2", name: "long_without_premium", severity: "blocker", part_index: 0, start: null, end: null, span_text: null, problem: "Long posts need X Premium, which is off in Settings → X.", repair: null, repair_label: "Switch to Thread" });
  }
  if (xFormat && w.source_reply && prefs.postSourceReply) {
    const c = countPost(w.source_reply, prefs.premium ? "long" : "single");
    if (c.over) add({ code: "D1", name: "length_over", severity: "blocker", part_index: -1, start: null, end: null, span_text: null, problem: `The source reply is ${c.weightedLength} of ${c.limit} characters.`, repair: null, repair_label: "Trim the reply or drop a line" });
  }

  for (const { text, index } of all) {
    for (const m of text.matchAll(PLACEHOLDER)) {
      add({ code: "D3", name: "placeholder", severity: "blocker", part_index: index, start: m.index!, end: m.index! + m[0].length, span_text: m[0], problem: "A placeholder is still in the text.", repair: "", repair_label: "Remove" });
    }
    if (index === -1) continue; // quotation and style checks apply to the post parts
    for (const q of findQuotations(text)) {
      const inner = q.inner.trim();
      if (inner.length < 2) {
        add({ code: "D4", name: "empty_quotation", severity: "blocker", part_index: index, start: q.start, end: q.end, span_text: text.slice(q.start, q.end), problem: "Empty quotation marks.", repair: null, repair_label: "Insert a matched quotation, or remove" });
        continue;
      }
      const scripture = matchScripture(inner, corpus);
      if (scripture) {
        // D6: Scripture quotations carry the translation abbreviation in the same sentence.
        const after = text.slice(q.end, q.end + 120);
        const sentenceEnd = after.search(/(?<=[.!?])\s|\n/);
        const window = sentenceEnd >= 0 ? after.slice(0, sentenceEnd + 1) : after;
        if (!new RegExp(`\\(\\s*${study.translation_id}\\s*\\)`).test(window) && !new RegExp(`\\b${study.translation_id}\\b`).test(window)) {
          add({ code: "D6", name: "scripture_attribution", severity: study.translation_id === "BSB" ? "suggestion" : "blocker", part_index: index, start: q.start, end: q.end, span_text: text.slice(q.start, q.end),
            problem: `Scripture quotation (${scripture.label}) without “(${study.translation_id})”.`, repair: `${text.slice(q.start, q.end)} (${study.translation_id})`, repair_label: `Append (${study.translation_id})` });
        }
        continue;
      }
      if (matchedCardQuotes.some((cq) => normalize(cq).text.includes(normalize(inner).text) || loose(cq).text.includes(loose(inner).text))) continue;
      let near: string | null = null;
      let found = false;
      for (const s of sourceTexts) {
        const m = matchQuotation(inner, s.text);
        if (m.level !== "not_found") {
          found = s.match_level !== "working_translation";
          break;
        }
        if (!near && m.nearMatch) near = m.nearMatch;
      }
      if (!found) {
        // Near-matches against Scripture give the exact wording as the repair.
        if (!near) {
          for (const v of corpus) {
            const m = matchQuotation(inner, v.text);
            if (m.nearMatch) {
              near = m.nearMatch;
              break;
            }
          }
        }
        if (!near) near = closestScripture(inner, corpus);
        add({ code: "D5", name: "unverified_quotation", severity: "blocker", part_index: index, start: q.start, end: q.end, span_text: text.slice(q.start, q.end),
          problem: near ? `These words aren't in any source or Scripture text. Closest wording: “${near}”` : "These words aren't in any stored source or Scripture text, so they can't appear in quotation marks.",
          repair: near ? `“${near}”${study.translation_id && corpus.some((v) => v.text.includes(near!)) ? ` (${study.translation_id})` : ""}` : inner, repair_label: near ? "Use the source's wording" : "Remove quotation marks" });
      }
      // D13: misattribution watchlist
    }

    // D8: auto-linked text in the post itself
    for (const e of xFormat ? findEntities(text) : []) {
      if (e.url) add({ code: "D8", name: "autolinked_text", severity: "judgment", part_index: index, start: e.indices[0], end: e.indices[1], span_text: e.url,
        problem: `“${e.url}” becomes a link. It counts 23 characters, raises the API price to $0.20, and links may reduce reach.`, repair: null, repair_label: "Move it to the source reply" });
    }
    // D14: hashtags and mentions
    const tags = findEntities(text).filter((e) => e.hashtag);
    const mentions = findEntities(text).filter((e) => e.screenName);
    if (xFormat && (tags.length > 1 || (index === 0 && mentions.length))) {
      const e = (mentions[0] ?? tags[0])!;
      add({ code: "D14", name: "hashtags", severity: "suggestion", part_index: index, start: e.indices[0], end: e.indices[1], span_text: text.slice(e.indices[0], e.indices[1]),
        problem: tags.length > 1 ? "More than one hashtag." : "An @mention in the main post.", repair: "", repair_label: "Remove" });
    }
    // D9: ambiguous authors
    for (const m of text.matchAll(/\bGregory\b(?!\s+(?:of|the|Nazianzen|Palamas|Thaumaturgus))/g)) {
      add({ code: "D9", name: "ambiguous_author", severity: "suggestion", part_index: index, start: m.index!, end: m.index! + m[0].length, span_text: m[0], problem: "Which Gregory? There are several in your directory.", repair: null, repair_label: "Use the full name (Gregory of Nyssa, Gregory the Great…)" });
    }
    // D10: references
    for (const ref of findReferencesInText(text)) {
      const exp = expandRange(ref.range);
      if (!exp.ok) add({ code: "D10", name: "reference_format", severity: "suggestion", part_index: index, start: ref.start, end: ref.end, span_text: ref.text, problem: exp.error, repair: exp.suggestion ?? null, repair_label: "Fix reference" });
    }
    // D11: banned phrases and patterns
    const lower = text.toLowerCase();
    for (const phrase of prefs.bannedPhrases) {
      const at = lower.indexOf(phrase.toLowerCase());
      if (at >= 0) add({ code: "D11", name: "banned_phrase", severity: "suggestion", part_index: index, start: at, end: at + phrase.length, span_text: text.slice(at, at + phrase.length), problem: `“${phrase}” is on your banned list.`, repair: null });
    }
    for (const m of text.matchAll(CONTRAST)) {
      add({ code: "D11", name: "banned_phrase", severity: "suggestion", part_index: index, start: m.index!, end: m.index! + m[0].length, span_text: m[0], problem: "The “it's not X, it's Y” template.", repair: null });
    }
    if (xFormat && (text.match(/—/g) ?? []).length > 2) add({ code: "D11", name: "banned_phrase", severity: "suggestion", part_index: index, start: null, end: null, span_text: null, problem: "More than two em dashes in one post.", repair: null });
    // D13: watchlist
    for (const wl of WATCHLIST) {
      const wlLoose = loose(wl.quote).text;
      const hit = loose(text).text.includes(wlLoose.slice(0, Math.min(wlLoose.length, 40))) ||
        findQuotations(text).some((q) => jaccard(trigrams(q.inner), trigrams(wl.quote)) >= 0.5);
      if (hit) {
        const sev: Severity = wl.status === "spurious" || wl.status === "unsourced" ? "blocker" : "judgment";
        add({ code: "D13", name: "misattribution_watchlist", severity: sev, part_index: index, start: null, end: null, span_text: wl.quote, problem: `Often attributed to ${wl.author} — ${wl.status}. ${wl.note}`, repair: null });
      }
    }
  }

  // D12 and the conclusion check: compare to posts from the last 120 days.
  const since = new Date(Date.now() - 120 * 86400_000).toISOString();
  const recent = db.prepare("SELECT p.text, p.posted_at, s.display_ref FROM posts p JOIN studies s ON s.id = p.study_id WHERE p.role = 'main' AND p.status = 'posted' AND p.posted_at >= ? AND p.study_id != ?").all(since, studyId) as any[];
  const first = (w.parts[0] ?? "").split("\n")[0];
  const lastSentence = (w.parts.at(-1) ?? "").split(/(?<=[.!?])\s+/).filter(Boolean).at(-1) ?? "";
  for (const p of xFormat ? recent : []) {
    if (first && jaccard(trigrams(first), trigrams(p.text.split("\n")[0])) >= 0.5) {
      add({ code: "D12", name: "repeated_opening", severity: "suggestion", part_index: 0, start: 0, end: first.length, span_text: first, problem: `A similar opening on ${new Date(p.posted_at).toLocaleDateString()} (${p.display_ref}).`, repair: null });
      break;
    }
    const theirLast = p.text.split(/(?<=[.!?])\s+/).filter(Boolean).at(-1) ?? "";
    if (lastSentence && jaccard(trigrams(lastSentence), trigrams(theirLast)) >= 0.5) {
      add({ code: "D12", name: "repeated_conclusion", severity: "suggestion", part_index: w.parts.length - 1, start: null, end: null, span_text: lastSentence, problem: `A similar conclusion on ${new Date(p.posted_at).toLocaleDateString()} (${p.display_ref}).`, repair: null });
      break;
    }
  }

  // Attach decisions the user made on deterministic judgments.
  const decisions = db.prepare("SELECT check_code, span_text, resolution, reason FROM finding_decisions WHERE study_id = ?").all(studyId) as any[];
  for (const f of findings) {
    const d = decisions.find((x) => x.check_code === f.code && x.span_text === (f.span_text ?? ""));
    if (d) {
      f.resolution = d.resolution;
      f.resolution_reason = d.reason;
    }
  }
  return findings;
}

function closestScripture(inner: string, corpus: { label: string; text: string }[]): string | null {
  const qw = new Set(words(inner));
  let best: { text: string; score: number } | null = null;
  for (const v of corpus) {
    const vw = new Set(words(v.text));
    let inter = 0;
    for (const w of qw) if (vw.has(w)) inter++;
    const score = inter / Math.max(1, qw.size);
    if (!best || score > best.score) best = { text: v.text, score };
  }
  return best && best.score >= 0.6 ? best.text : null;
}

// ---------- Model review ----------

const MODEL_CODES: Record<string, { code: string; severity: Severity }> = {
  misattribution: { code: "M1", severity: "judgment" },
  unsupported_claim: { code: "M2", severity: "judgment" },
  overstatement: { code: "M3", severity: "judgment" },
  context: { code: "M4", severity: "judgment" },
  first_line_alone: { code: "M5", severity: "judgment" },
  reader_inference: { code: "M6", severity: "judgment" },
  invented_relation: { code: "M7", severity: "judgment" },
  theology_frame: { code: "M8", severity: "judgment" },
  strengthen: { code: "M9", severity: "suggestion" },
  clarity: { code: "M10", severity: "suggestion" },
};

export async function modelReview(db: DB, studyId: string) {
  const study = db.prepare("SELECT * FROM studies WHERE id = ?").get(studyId) as any;
  const w = getWorkingText(db, studyId);
  if (!w || !w.parts.some((p) => p.trim())) throw new HttpError(400, "There isn't a draft to check yet. Your study is saved; add some writing first.");
  const prefs = getPrefs(db);
  // What the post may rest on: the items the user marked, and the items the draft drew on.
  const lastDraft = w.origin_draft_id ? db.prepare("SELECT claim_map_json, card_ids_json FROM drafts WHERE id = ? AND study_id = ?").get(w.origin_draft_id, studyId) as any : null;
  const ids = [...new Set([...selectedCardIds(db, studyId), ...json<string[]>(lastDraft?.card_ids_json, [])])].filter((id) => (db.prepare("SELECT status_interpretation s FROM cards WHERE id = ?").get(id) as any)?.s !== "disputed");
  const { cards } = cardsForModel(db, ids);
  const drawn = await scriptureDrawnOn(db, study);
  const res = await callStructured<ReviewOutput>({
    db, stage: "review", promptVersion: VERSIONS.review, system: systemPrompt(prefs),
    user: reviewPrompt({ format: w.format, decided: decidedBefore(db, studyId), parts: w.parts, sourceReply: w.source_reply, translation: study.translation_id, passage: await passageTextFor(db, study), context: await contextTextFor(study), drawsOn: drawnOnText(drawn, study.translation_id), cards: JSON.stringify(cards), claimMap: lastDraft?.claim_map_json ?? "" }),
    schema: REVIEW_SCHEMA, effort: "medium", maxTokens: 12000, studyId,
  });
  // The text may have changed while the model was thinking; the review belongs to the text it saw.
  const reviewId = uuidv7();
  const supportedCards = cards.length > 0 || !!db.prepare("SELECT 1 FROM cards WHERE study_id = ? LIMIT 1").get(studyId);
  db.transaction(() => {
    db.prepare("INSERT INTO reviews (id, study_id, kind, text_hash, first_line_reading, overall, llm_call_id, created_at) VALUES (?,?,?,?,?,?,?,?)").run(reviewId, studyId, "model", w.text_hash, res.data.first_line_reading, res.data.overall, res.callId, nowIso());
    const ins = db.prepare("INSERT INTO findings (id, review_id, check_code, severity, part_index, span_text, problem, repair, support_refs_json) VALUES (?,?,?,?,?,?,?,?,?)");
    // A decision the user already made on the same words carries over to the new check.
    const earlier = db.prepare(
      `SELECT f.resolution, f.resolution_reason FROM findings f JOIN reviews r ON r.id = f.review_id
        WHERE r.study_id = ? AND f.check_code = ? AND f.resolution IN ('kept','dismissed') AND f.span_text != ''
          AND (instr(?, f.span_text) > 0 OR instr(f.span_text, ?) > 0) ORDER BY r.created_at DESC LIMIT 1`,
    );
    const carry = db.prepare("UPDATE findings SET resolution = ?, resolution_reason = ? WHERE id = ?");
    for (const f of res.data.findings) {
      if (!isXFormat(w.format) && f.check === "first_line_alone") continue;
      const meta = MODEL_CODES[f.check] ?? { code: "M10", severity: "suggestion" as Severity };
      // M1 is a blocker when no provided evidence supports the attribution at all.
      let severity = meta.severity;
      if (meta.code === "M1" && (!supportedCards || /no (provided )?evidence|not in the evidence|nothing in the evidence/i.test(f.problem))) severity = "blocker";
      const refs = (f.support_refs ?? []).map((r) => parseReference(r)).filter((p) => p.ok).map((p: any) => p.range);
      const valid = refs.map((r: any) => expandRange(r)).filter((e: any) => e.ok).map((e: any) => toUsfm(e.range));
      const id = uuidv7();
      ins.run(id, reviewId, meta.code, severity, f.part_index, f.quote_from_post, f.problem, bareRepair(f.repair, f.quote_from_post), JSON.stringify(valid));
      const prior = earlier.get(studyId, meta.code, f.quote_from_post, f.quote_from_post) as { resolution: string; resolution_reason: string | null } | undefined;
      if (prior) carry.run(prior.resolution, prior.resolution_reason, id);
    }
  })();
  return reviewId;
}

/** Findings the user kept or dismissed in earlier checks, so a re-check doesn't raise them again. */
function decidedBefore(db: DB, studyId: string): string {
  const rows = db.prepare(
    `SELECT f.span_text, f.problem, f.resolution, f.resolution_reason FROM findings f JOIN reviews r ON r.id = f.review_id
      WHERE r.study_id = ? AND f.resolution IN ('kept','dismissed') ORDER BY r.created_at DESC LIMIT 12`,
  ).all(studyId) as any[];
  return rows.map((r) => `- "${r.span_text}": ${r.problem} → the user ${r.resolution} it${r.resolution_reason ? ` (${r.resolution_reason})` : ""}.`).join("\n");
}

/** Models often wrap a replacement in quotation marks; applying it would put them in the post. Keep them only if the span had them. */
export function bareRepair(repair: string | null, span: string): string | null {
  if (repair === null) return null;
  const r = repair.trim();
  const wrapped = /^[“"][\s\S]*[”"]$/.test(r);
  const spanWrapped = /^[“"][\s\S]*[”"]$/.test(span.trim());
  return wrapped && !spanWrapped ? r.slice(1, -1).trim() : r;
}

export async function modelFindings(db: DB, studyId: string, w: WorkingText | null): Promise<{ review: any | null; findings: Finding[]; stale: boolean }> {
  const review = db.prepare("SELECT * FROM reviews WHERE study_id = ? AND kind = 'model' ORDER BY created_at DESC LIMIT 1").get(studyId) as any;
  if (!review) return { review: null, findings: [], stale: false };
  const stale = !w || review.text_hash !== w.text_hash;
  const study = db.prepare("SELECT translation_id FROM studies WHERE id = ?").get(studyId) as any;
  const prefs = getPrefs(db);
  const rows = db.prepare("SELECT * FROM findings WHERE review_id = ?").all(review.id) as any[];
  const out: Finding[] = [];
  for (const r of rows) {
    const part = r.part_index === -1 ? w?.source_reply ?? "" : w?.parts[r.part_index] ?? "";
    let start: number | null = null;
    let end: number | null = null;
    if (r.span_text) {
      const at = part.indexOf(r.span_text);
      if (at >= 0) {
        start = at;
        end = at + r.span_text.length;
      } else {
        const nPart = normalize(part);
        const nSpan = normalize(r.span_text).text;
        const i = nSpan ? nPart.text.indexOf(nSpan) : -1;
        if (i >= 0) {
          start = nPart.map[i];
          end = nPart.map[i + nSpan.length - 1] + 1;
        }
      }
    }
    const support: Finding["support"] = [];
    for (const ref of json<string[]>(r.support_refs_json, [])) {
      const range = fromUsfm(ref);
      if (!range) continue;
      try {
        const vs: string[] = [];
        for (let c = range.c1; c <= range.c2; c++) {
          const ch = await getChapter({ id: study.translation_id }, range.book, c);
          for (const v of ch.verses) if ((c > range.c1 || v.n >= (range.v1 ?? 1)) && (c < range.c2 || v.n <= (range.v2 ?? 999))) vs.push(v.text);
        }
        support.push({ ref, display: displayRef(range), text: vs.join(" ") });
      } catch {
        /* skip */
      }
    }
    out.push({
      key: r.id, id: r.id, source: "model", code: r.check_code, name: Object.entries(MODEL_CODES).find(([, v]) => v.code === r.check_code)?.[0] ?? r.check_code,
      severity: r.severity, part_index: r.part_index ?? 0, start, end, span_text: r.span_text, problem: r.problem, repair: r.repair, support,
      resolution: r.resolution, resolution_reason: r.resolution_reason,
    });
  }
  return { review, findings: out, stale };
}

export interface Gate {
  canPublish: boolean;
  reasons: string[];
  modelReview: "none" | "stale" | "current";
  textHash: string | null;
}

export async function computeGate(db: DB, studyId: string, w = getWorkingText(db, studyId), det?: Finding[]): Promise<{ gate: Gate; deterministic: Finding[]; model: Finding[]; review: any | null }> {
  if (!w || !w.parts.some((p) => p.trim())) {
    return { gate: { canPublish: false, reasons: ["Write a first draft"], modelReview: "none", textHash: null }, deterministic: [], model: [], review: null };
  }
  const deterministic = det ?? (await deterministicReview(db, studyId, w));
  const m = await modelFindings(db, studyId, w);
  const reasons: string[] = [];
  const blockers = deterministic.filter((f) => f.severity === "blocker").length;
  if (blockers) reasons.push(`${blockers} blocker${blockers > 1 ? "s" : ""} to fix`);
  const detJudgments = deterministic.filter((f) => f.severity === "judgment" && f.resolution !== "kept").length;
  let modelState: Gate["modelReview"] = "none";
  if (!m.review) reasons.push(isXFormat(w.format) ? "Run Check before publishing" : "Check this draft for accuracy");
  else if (m.stale) {
    modelState = "stale";
    reasons.push("Text changed since the last check — Check again");
  } else {
    modelState = "current";
    const mb = m.findings.filter((f) => f.severity === "blocker").length;
    if (mb) reasons.push(`${mb} blocker${mb > 1 ? "s" : ""} from the check to fix`);
  }
  const mj = modelState === "current" ? m.findings.filter((f) => f.severity === "judgment" && !f.resolution).length : 0;
  const undecided = detJudgments + mj;
  if (undecided) reasons.push(`Decide on ${undecided} item${undecided > 1 ? "s" : ""} that need${undecided > 1 ? "" : "s"} your judgment`);
  return { gate: { canPublish: isXFormat(w.format) && reasons.length === 0, reasons, modelReview: modelState, textHash: w.text_hash }, deterministic, model: m.findings, review: m.review };
}

export { textHash };
export type { Preferences };
