import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { DB } from "./db.ts";
import { uuidv7, nowIso, localDate, json, indexEntity } from "./db.ts";
import { APP_ID, APP_NAME, APP_VERSION, PUBLICATION, RESEARCH_MODEL, WRITING_MODEL } from "./config.ts";
import { subscribe } from "./events.ts";
import { getPrefs, setPrefs, DEFAULT_PREFS } from "./prefs.ts";
import { hasSecret, setSecret } from "./secrets.ts";
import { testOpenaiKey, callStructured, ModelError } from "./llm.ts";
import { monthTotals, BudgetError } from "./costs.ts";
import { datasetStatus, downloadDataset, DATASETS, type DatasetName } from "./datasets.ts";
import { getChapter, expandRange, rangeOrds, verseCountInRange, bsbAvailable } from "./bible.ts";
import { getVerseOfTheDay, shufflePassage } from "./votd.ts";
import { parseReference, toUsfm, displayRef, fromUsfm, bookByUsfm, BOOKS } from "../shared/refs.ts";
import { wordCount } from "../shared/text.ts";
import { requestResearch, researchState, cancelRun, STAGES, HIDDEN_CARD_SQL } from "./pipeline.ts";
import { findAngles, draft, sharpen, getDraft, getWorkingText, getWorkingTextVariants, saveWorkingText, switchWritingFormat, splitIntoThread, notesWords, suggestTitle, voiceSamples } from "./writing.ts";
import { wordStudy, passageWords } from "./words.ts";
import { stepbibleAvailable } from "./sources/stepbible.ts";
import { WRITING_FORMATS } from "../shared/writing.ts";
import { computeGate, modelReview, deterministicReview } from "./review.ts";
import { startPublish, publishState, recordReceipt, skipPost, PublishError } from "./publish.ts";
import { tailLog } from "./log.ts";
import { HttpError } from "./errors.ts";
import { studyMarkdown, writeRecord, refreshRecord, writeAllRecords, friendlyPath } from "./records.ts";
import { backupNow, listBackups } from "./backup.ts";
import { buildStudyExport } from "./research-export.ts";
import { inspectResearchCorpus, approveResearchCorpus, revokeResearchCorpus, buildResearchCorpusExport } from "./research-corpus.ts";
import { BACKUP_DIR, NOTES_DIR } from "./config.ts";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { systemPrompt, translatePrompt, TRANSLATE_SCHEMA, VERSIONS } from "./prompts.ts";


function fail(reply: FastifyReply, e: unknown) {
  if (e instanceof z.ZodError) return reply.code(400).send({ error: "That request wasn't valid.", details: e.issues });
  if (e instanceof HttpError || e instanceof PublishError) return reply.code(e.status).send({ error: e.message });
  if (e instanceof BudgetError) return reply.code(402).send({ error: e.message, cap: e.cap });
  if (e instanceof ModelError) return reply.code(e.kind === "no_key" ? 412 : 502).send({ error: e.message, kind: e.kind });
  return reply.code(500).send({ error: e instanceof Error ? e.message : String(e) });
}

function getStudy(db: DB, id: string) {
  const s = db.prepare("SELECT * FROM studies WHERE id = ?").get(id) as any;
  if (!s) throw new HttpError(404, "That study doesn't exist.");
  return s;
}

function studyRow(s: any) {
  return { ...s, tags: json<string[]>(s.tags_json, []), include_in_archive: !!s.include_in_archive };
}

/** A lexicon entry's word and the verse it was looked up in ("stepbible:G1252:JUD.1.22", maybe with "#snapshot=…"), so it can open as a word study. */
function lexiconWord(e: { kind: string; dataset_ref?: string | null }): { strong: string; at: string } | null {
  const m = e.kind === "lexicon_entry" ? /^stepbible:([HG]\d{4}[A-Za-z]?):([1-3]?[A-Z]{2,3}\.\d+\.\d+)(?:#.*)?$/.exec(e.dataset_ref ?? "") : null;
  return m ? { strong: m[1], at: m[2] } : null;
}

function overlapping(db: DB, start: number, end: number, excludeId?: string) {
  return db
    .prepare("SELECT id, display_ref, title, status, created_local_date, note FROM studies WHERE ref_start_ord <= ? AND ref_end_ord >= ? AND id != ? ORDER BY created_at DESC LIMIT 5")
    .all(end, start, excludeId ?? "")
    .map((r: any) => ({ ...r, note: r.note ? r.note.slice(0, 280) : null }));
}

export function registerRoutes(app: FastifyInstance, db: DB) {
  const wrap =
    <T>(fn: (req: any, reply: FastifyReply) => Promise<T> | T) =>
    async (req: any, reply: FastifyReply) => {
      try {
        const out = await fn(req, reply);
        if (!reply.sent) return out;
      } catch (e) {
        return fail(reply, e);
      }
    };

  app.get("/api/health", async () => ({ id: APP_ID, app: APP_NAME, version: APP_VERSION }));

  // ---- Server-sent events ----
  app.get("/api/events", (req, reply) => {
    reply.raw.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    reply.raw.write(": connected\n\n");
    const unsub = subscribe((event, data) => reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
    const ping = setInterval(() => reply.raw.write(": ping\n\n"), 25_000);
    req.raw.on("close", () => {
      clearInterval(ping);
      unsub();
    });
  });

  // ---- App status ----
  app.get("/api/status", wrap(() => {
    const p = getPrefs(db);
    return {
      app: APP_NAME, publication: PUBLICATION, models: { research: RESEARCH_MODEL, writing: WRITING_MODEL }, onboarded: p.onboarded,
      keys: { openai: hasSecret("openai_api_key") },
      datasets: datasetStatus(), costs: monthTotals(db), budgets: p.budgets, today: localDate(),
    };
  }));

  // ---- Today ----
  app.get("/api/today", wrap(async () => {
    const prefs = getPrefs(db);
    const date = localDate();
    const open = db.prepare("SELECT * FROM studies WHERE status = 'open' ORDER BY updated_at DESC LIMIT 1").get() as any;
    const todayStudies = db.prepare("SELECT id, display_ref, status, title FROM studies WHERE created_local_date = ? ORDER BY created_at DESC").all(date) as any[];
    // Today's reading stays visible even when yesterday's study is still open.
    // Resume and the Sunday text are independent, secondary choices.
    const v = await getVerseOfTheDay(db, date);
    const proposal = { ref: v.ref, display: displayRef(fromUsfm(v.ref)!), origin: "votd", label: "Verse of the day", source: v.source };
    let sunday: { ref: string; display: string; origin: string; date: string } | null = null;
    if (prefs.sundayText?.ref && prefs.sundayText.date >= date) {
      const p = parseReference(prefs.sundayText.ref);
      if (p.ok) {
        const e = expandRange(p.range);
        if (e.ok) sunday = { ref: toUsfm(e.range), display: displayRef(e.range), origin: "sunday_text", date: prefs.sundayText.date };
      }
    }
    const r = fromUsfm(proposal.ref)! as { book: string; c1: number; v1: number; c2: number; v2: number };
    let proposalText: { n: number; text: string }[] = [];
    let passageError: string | null = null;
    try {
      const ch = await getChapter({ id: prefs.translation }, r.book, r.c1);
      proposalText = ch.verses.filter((verse) => verse.n >= r.v1 && (r.c2 > r.c1 || verse.n <= r.v2)).map((verse) => ({ n: verse.n, text: verse.text }));
    } catch {
      passageError = "The passage preview couldn't load. Your saved studies are still available. Open Settings → Data to check the Bible download.";
    }
    const o = rangeOrds(r);
    return { date, proposal, proposalText, prior: overlapping(db, o.start, o.end), open: open ? studyRow(open) : null, sunday, todayStudies, passageError, weeklyPrompt: new Date().getDay() === 5, translation: prefs.translation };
  }));

  app.get("/api/verses/shuffle", wrap(async (req) => {
    const { exclude } = z.object({ exclude: z.string().max(8192).optional() }).parse(req.query);
    const picked = shufflePassage(db, exclude?.split(",").filter(Boolean) ?? []);
    const r = fromUsfm(picked.ref)! as { book: string; c1: number; v1: number; c2: number; v2: number };
    const translation = getPrefs(db).translation;
    const chapter = await getChapter({ id: translation }, r.book, r.c1);
    const proposalText = chapter.verses.filter((verse) => verse.n >= r.v1 && (r.c2 > r.c1 || verse.n <= r.v2)).map((verse) => ({ n: verse.n, text: verse.text }));
    const o = rangeOrds(r);
    return {
      proposal: { ref: picked.ref, display: displayRef(r), origin: "manual", source: picked.source, label: picked.source === "library" ? "From your saved studies" : "A passage to explore" },
      proposalText, translation, prior: overlapping(db, o.start, o.end),
    };
  }));

  app.post("/api/parse-ref", wrap(async (req) => {
    const { text } = z.object({ text: z.string() }).parse(req.body);
    const p = parseReference(text);
    if (!p.ok) return p;
    const e = expandRange(p.range);
    if (!e.ok) return e;
    const o = rangeOrds(e.range);
    // A short preview of the text, so the passage can be seen before a study starts.
    let preview: { n: number; text: string }[] = [];
    try {
      const r = e.range as any;
      const ch = await getChapter({ id: getPrefs(db).translation }, r.book, r.c1);
      preview = ch.verses.filter((v) => v.n >= r.v1 && (r.c2 > r.c1 || v.n <= r.v2)).slice(0, 4).map((v) => ({ n: v.n, text: v.text }));
    } catch {
      /* the preview is optional */
    }
    return { ok: true, ref: toUsfm(e.range), display: displayRef(e.range), verses: verseCountInRange(e.range), prior: overlapping(db, o.start, o.end), preview };
  }));

  // ---- Studies ----
  app.post("/api/studies", wrap((req) => {
    const body = z.object({ ref: z.string(), origin: z.enum(["votd", "continue", "series", "sunday_text", "manual", "later"]), parentStudyId: z.string().nullish(), laterItemId: z.string().nullish(), question: z.string().nullish() }).parse(req.body);
    const p = parseReference(body.ref);
    if (!p.ok) throw new HttpError(400, p.suggestion ? `${p.error} Did you mean ${p.suggestion}?` : p.error);
    const e = expandRange(p.range);
    if (!e.ok) throw new HttpError(400, e.suggestion ? `${e.error} Did you mean ${e.suggestion}?` : e.error);
    const prefs = getPrefs(db);
    const id = uuidv7();
    const o = rangeOrds(e.range);
    const now = nowIso();
    let question = body.question ?? null;
    if (body.laterItemId) {
      const li = db.prepare("SELECT * FROM later_items WHERE id = ?").get(body.laterItemId) as any;
      if (li?.kind === "question" && !question) question = li.text;
    }
    db.transaction(() => {
      db.prepare(
        `INSERT INTO studies (id, primary_ref, display_ref, ref_start_ord, ref_end_ord, translation_id, origin, parent_study_id, status, question, format, created_local_date, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(id, toUsfm(e.range), displayRef(e.range), o.start, o.end, prefs.translation, body.origin, body.parentStudyId ?? null, "open", question, prefs.lastFormat === "long" && !prefs.premium ? "single" : prefs.lastFormat, localDate(), now, now);
      if (body.laterItemId) db.prepare("UPDATE later_items SET used_in_study_id = ? WHERE id = ?").run(id, body.laterItemId);
      indexEntity(db, "study", id, id, displayRef(e.range), question ?? "");
    })();
    return { id, warning: verseCountInRange(e.range) > 30 ? "Long ranges make thin briefs." : null };
  }));

  app.get("/api/studies", wrap((req) => {
    const q = z.object({ q: z.string().optional(), status: z.string().optional(), book: z.string().optional() }).parse(req.query);
    let rows: any[];
    const snippets = new Map<string, string[]>();
    if (q.q && q.q.trim()) {
      const match = q.q
        .trim()
        .split(/\s+/)
        .map((t) => `"${t.replace(/"/g, "")}"*`)
        .join(" ");
      const hits = db
        .prepare(`SELECT study_id, entity_type, snippet(search_index, 4, '[[', ']]', '…', 14) AS snip, bm25(search_index, 0, 0, 0, 10.0, 1.0) AS score FROM search_index WHERE search_index MATCH ? ORDER BY score LIMIT 200`)
        .all(match) as any[];
      const ids: string[] = [];
      for (const h of hits) {
        if (!snippets.has(h.study_id)) {
          snippets.set(h.study_id, []);
          ids.push(h.study_id);
        }
        if (h.snip && snippets.get(h.study_id)!.length < 2) snippets.get(h.study_id)!.push(h.snip);
      }
      // Reference searches ("Exodus 33") also match by passage.
      const pr = parseReference(q.q);
      if (pr.ok) {
        const e = expandRange(pr.range);
        if (e.ok) {
          const o = rangeOrds(e.range);
          for (const r of overlapping(db, o.start, o.end)) if (!snippets.has(r.id)) { snippets.set(r.id, []); ids.unshift(r.id); }
        }
      }
      rows = ids.map((id) => db.prepare("SELECT * FROM studies WHERE id = ?").get(id)).filter(Boolean) as any[];
    } else {
      rows = db.prepare("SELECT * FROM studies ORDER BY created_at DESC LIMIT 500").all() as any[];
    }
    if (q.status) rows = rows.filter((r) => r.status === q.status);
    if (q.book) rows = rows.filter((r) => r.primary_ref.startsWith(q.book + "."));
    return rows.map((r) => {
      const post = db.prepare("SELECT text, x_url FROM posts WHERE study_id = ? AND role = 'main' AND status = 'posted' ORDER BY posted_at DESC LIMIT 1").get(r.id) as any;
      const wt = getWorkingText(db, r.id);
      const shown = wt?.parts.some((p) => p.trim()) ? wt : getWorkingTextVariants(db, r.id).find((v) => v.parts.some((p) => p.trim()));
      const parts = shown?.parts.filter((p) => p.trim()) ?? [];
      return {
        ...studyRow(r), firstLine: (post?.text ?? parts[0] ?? r.note ?? "").split("\n")[0].slice(0, 200), postUrl: post?.x_url ?? null, snippets: snippets.get(r.id) ?? [], bookIndex: bookByUsfm(r.primary_ref.split(".")[0])?.index ?? 0,
        // What the row shows: the post if there is one, otherwise the note.
        excerpt: (post?.text ?? parts[0] ?? r.note ?? "").trim().slice(0, 320), excerptKind: post ? "posted" : parts.length ? "post" : r.note?.trim() ? "note" : null,
        excerptFormat: post ? "single" : shown?.format ?? r.format,
        partCount: parts.length, hasRecord: !!r.record_path, researched: !!db.prepare("SELECT 1 FROM cards WHERE study_id = ? LIMIT 1").get(r.id),
      };
    });
  }));

  app.get("/api/books", wrap(() => BOOKS.map((b) => ({ usfm: b.usfm, name: b.name, index: b.index }))));

  app.get("/api/studies/:id", wrap(async (req) => {
    const s = getStudy(db, req.params.id);
    const prefs = getPrefs(db);
    const r = fromUsfm(s.primary_ref)! as any;
    const t = { id: s.translation_id };
    let passage: any = null;
    let passageError: string | null = null;
    try {
      const chapters = [];
      for (let c = r.c1; c <= r.c2; c++) chapters.push(await getChapter(t, r.book, c));
      passage = { chapters, range: r, translation: s.translation_id, copyright: s.translation_id === "BSB" ? "The Holy Bible, Berean Standard Bible, BSB is produced in cooperation with Bible Hub, Discovery Bible, OpenBible.com, and the Berean Bible Translation Committee. This text of God's Word has been dedicated to the public domain." : null };
    } catch (e) {
      passageError = e instanceof Error ? e.message : String(e);
    }
    const runs = (db.prepare("SELECT * FROM research_runs WHERE study_id = ? ORDER BY queued_at").all(s.id) as any[]).map((run) => ({
      ...run, stages: json(run.stages_json, {}), writer_questions: json<string[]>(run.writer_questions_json, []), brief: json(run.brief_json, {}),
      gaps: db.prepare("SELECT author_name, note FROM gaps WHERE run_id = ?").all(run.id),
      sourceCount: (db.prepare("SELECT COUNT(*) n FROM run_sources WHERE run_id = ?").get(run.id) as any).n,
    }));
    const scriptureOf = db.prepare(`SELECT DISTINCT s.locator AS label, e.text FROM card_evidence ce JOIN excerpts e ON e.id = ce.excerpt_id JOIN sources s ON s.id = e.source_id WHERE ce.card_id = ? AND s.kind = 'cross_reference'`);
    const quotesOf = db.prepare(`SELECT ce.quote_text, s.kind, s.locator, s.title, s.author_name FROM card_evidence ce JOIN excerpts e ON e.id = ce.excerpt_id JOIN sources s ON s.id = e.source_id
      WHERE ce.card_id = ? AND ce.use = 'quote' AND ce.match IN ('exact','loose','elided') AND ce.quote_text IS NOT NULL ORDER BY ce.rowid`);
    /** Whose words a quotation is: a verse (with its translation) or a named voice, for the line it makes in your notes. */
    const citeOf = (q: any) =>
      q.kind === "cross_reference" && q.locator ? `${q.locator} (${s.translation_id})`
        : q.kind === "bible_text" ? String(q.title)
        : String(q.author_name || q.title || "").replace(/\s+[—–]\s+/g, ", ");
    const cards = (db.prepare(`SELECT * FROM cards WHERE study_id = ? AND NOT (${HIDDEN_CARD_SQL}) ORDER BY run_id, priority, created_at`).all(s.id) as any[]).map((c) => ({
      ...c, flags: json<string[]>(c.flags_json, []), selected: !!c.selected, visible_by_default: !!c.visible_by_default, data: json(c.data_json, {}),
      sources: db.prepare(`SELECT DISTINCT s.id, s.title, s.url, s.kind, s.rights, s.author_name, s.work, s.locator FROM card_evidence ce JOIN excerpts e ON e.id = ce.excerpt_id JOIN sources s ON s.id = e.source_id WHERE ce.card_id = ?`).all(c.id),
      // The connected passages' own words, for Scripture items; and the matched quotations, for voices.
      scripture: (scriptureOf.all(c.id) as any[]).map((x) => ({ label: x.label, text: String(x.text).replace(/\[\d+:\d+\]\s?/g, "").trim() })),
      ...((rows) => ({ quotes: rows.map((x) => x.quote_text), quote_cites: rows.map(citeOf) }))(quotesOf.all(c.id) as any[]),
    }));
    const wt = getWorkingText(db, s.id);
    const lastDraft = db.prepare("SELECT id FROM drafts WHERE study_id = ? AND format = ? ORDER BY created_at DESC, id DESC LIMIT 1").get(s.id, s.format) as any;
    const drafts = (db.prepare("SELECT id FROM drafts WHERE study_id = ? AND format = ? ORDER BY created_at DESC, id DESC LIMIT 5").all(s.id, s.format) as any[]).map((d) => getDraft(db, d.id));
    const review = await computeGate(db, s.id, wt);
    const o = { start: s.ref_start_ord, end: s.ref_end_ord };
    const activity = db.prepare("SELECT COALESCE(SUM(active_seconds),0) a, COALESCE(SUM(research_wait_seconds),0) w FROM activity WHERE study_id = ?").get(s.id) as any;
    const cost = (db.prepare("SELECT COALESCE(SUM(usd_micros),0) s FROM cost_ledger WHERE study_id = ?").get(s.id) as any).s;
    return {
      study: studyRow(s), passage, passageError, runs, cards, working: wt, lastDraft: lastDraft ? getDraft(db, lastDraft.id) : null, drafts,
      availableFormats: getWorkingTextVariants(db, s.id).filter((v) => v.parts.some((p) => p.trim())).map((v) => v.format),
      // Every piece written from this study (a journal entry, an X post…), for the finished page.
      pieces: getWorkingTextVariants(db, s.id).filter((v) => v.parts.some((p) => p.trim())).map((v) => ({ format: v.format, parts: v.parts, source_reply: v.source_reply ?? "" })),
      gate: review.gate, findings: { deterministic: review.deterministic, model: review.model }, review: review.review,
      publish: publishState(db, s.id), prior: overlapping(db, o.start, o.end, s.id), stages: STAGES,
      noteWords: notesWords(s), drawnOn: json(s.allusions_json, []), premium: prefs.premium, xHandle: prefs.xHandle, xDisplayName: prefs.xDisplayName, postSourceReply: prefs.postSourceReply,
      activity: { activeSeconds: activity.a, waitSeconds: activity.w }, costMicros: cost, research: researchState(db, s.id),
      corrections: db.prepare("SELECT * FROM corrections WHERE study_id = ? ORDER BY created_at").all(s.id),
      parent: s.parent_study_id ? db.prepare("SELECT id, display_ref, title, note FROM studies WHERE id = ?").get(s.parent_study_id) : null,
    };
  }));

  app.patch("/api/studies/:id", wrap((req) => {
    const s = getStudy(db, req.params.id);
    const body = z
      .object({
        title: z.string().nullish(), question: z.string().nullish(), first_observation: z.string().nullish(), note: z.string().nullish(),
        status: z.enum(["open", "saved", "published", "archived"]).optional(), endorsement: z.enum(["endorsed", "unresolved", "revised"]).optional(),
        tags: z.array(z.string()).optional(), include_in_archive: z.boolean().optional(),
      })
      .parse(req.body);
    const now = nowIso();
    db.transaction(() => {
      const sets: string[] = [];
      const vals: any[] = [];
      for (const k of ["title", "question", "first_observation", "note", "status", "endorsement"] as const) {
        if (body[k] !== undefined) {
          sets.push(`${k} = ?`);
          vals.push(body[k]);
        }
      }
      // A title you type is yours: the app never replaces it with one it chose.
      if (body.title !== undefined) sets.push("title_auto = 0");
      if (body.tags) {
        sets.push("tags_json = ?");
        vals.push(JSON.stringify(body.tags));
      }
      if (body.include_in_archive !== undefined) {
        sets.push("include_in_archive = ?");
        vals.push(body.include_in_archive ? 1 : 0);
      }
      if (body.note !== undefined) {
        sets.push("note_updated_at = ?");
        vals.push(now);
        const last = db.prepare("SELECT id, created_at FROM note_revisions WHERE study_id = ? ORDER BY created_at DESC LIMIT 1").get(s.id) as any;
        if (last && Date.now() - Date.parse(last.created_at) < 30_000) db.prepare("UPDATE note_revisions SET note = ? WHERE id = ?").run(body.note ?? "", last.id);
        else db.prepare("INSERT INTO note_revisions (id, study_id, note, created_at) VALUES (?,?,?,?)").run(uuidv7(), s.id, body.note ?? "", now);
      }
      if (!sets.length) return;
      sets.push("updated_at = ?");
      vals.push(now, s.id);
      db.prepare(`UPDATE studies SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
      const u = db.prepare("SELECT * FROM studies WHERE id = ?").get(s.id) as any;
      indexEntity(db, "study", u.id, u.id, `${u.display_ref} ${u.title ?? ""}`, [u.question, u.first_observation, u.note].filter(Boolean).join("\n"));
    })();
    refreshRecord(db, s.id);
    return studyRow(db.prepare("SELECT * FROM studies WHERE id = ?").get(s.id));
  }));

  /** Save: mark the study saved (unless it's already posted) and write its Markdown record. */
  app.post("/api/studies/:id/save", wrap(async (req) => {
    const s = getStudy(db, req.params.id);
    if (s.status === "open" || s.status === "archived") db.prepare("UPDATE studies SET status = 'saved', updated_at = ? WHERE id = ?").run(nowIso(), s.id);
    let file: string;
    try {
      file = await writeRecord(db, s.id, { saved: true });
    } catch (e) {
      throw new HttpError(500, `Saved in the app, but the file didn't write (${(e as Error).message}). Your work is safe; check that ${friendlyPath(NOTES_DIR)} is writable, then choose Finish again.`);
    }
    return { study: studyRow(db.prepare("SELECT * FROM studies WHERE id = ?").get(s.id)), path: file, where: friendlyPath(path.dirname(file)), file: path.basename(file) };
  }));

  app.post("/api/studies/:id/reveal", wrap((req) => {
    const s = getStudy(db, req.params.id);
    if (!s.record_path || !fs.existsSync(s.record_path)) throw new HttpError(404, "This study has no file yet. Save it first.");
    if (process.env.COMMENTARY_TEST !== "1") execFile("open", ["-R", s.record_path]);
    return { ok: true };
  }));

  /** Earlier versions of the note and the post, newest first. */
  app.get("/api/studies/:id/history", wrap((req) => {
    const s = getStudy(db, req.params.id);
    return {
      note: db.prepare("SELECT id, note, created_at FROM note_revisions WHERE study_id = ? ORDER BY created_at DESC LIMIT 60").all(s.id),
      post: (db.prepare("SELECT id, parts_json, source_reply, text_hash, cause, created_at, format FROM text_revisions WHERE study_id = ? AND format = ? ORDER BY created_at DESC, rowid DESC LIMIT 60").all(s.id, s.format) as any[]).map((r) => ({
        id: r.id, format: r.format, parts: json<string[]>(r.parts_json, []), source_reply: r.source_reply ?? "", text_hash: r.text_hash, cause: r.cause, created_at: r.created_at,
      })),
    };
  }));

  app.delete("/api/studies/:id", wrap((req) => {
    const s = getStudy(db, req.params.id);
    const posted = (db.prepare("SELECT COUNT(*) n FROM posts WHERE study_id = ? AND status = 'posted'").get(s.id) as any).n;
    if (posted) throw new HttpError(400, "Published studies are kept as records. Archive it instead.");
    db.prepare("UPDATE studies SET status = 'archived', updated_at = ? WHERE id = ?").run(nowIso(), s.id);
    return { ok: true };
  }));

  // ---- Research ----
  app.post("/api/studies/:id/research", wrap((req) => {
    const s = getStudy(db, req.params.id);
    const { depth } = z.object({ depth: z.enum(["standard", "deeper", "fill"]).default("standard") }).parse(req.body ?? {});
    if (!bsbAvailable()) throw new HttpError(412, "Download the Bible text first (Settings → Data).");
    return requestResearch(db, s.id, depth);
  }));
  app.post("/api/runs/:id/cancel", wrap((req) => {
    cancelRun(db, req.params.id);
    return { ok: true };
  }));

  app.patch("/api/cards/:id", wrap((req) => {
    const body = z.object({ selected: z.boolean().optional(), status_interpretation: z.enum(["unreviewed", "reviewed", "disputed"]).optional(), dispute_reason: z.string().nullish() }).parse(req.body);
    const c = db.prepare("SELECT * FROM cards WHERE id = ?").get(req.params.id) as any;
    if (!c) throw new HttpError(404, "That card doesn't exist.");
    if (body.status_interpretation === "disputed" && !(body.dispute_reason ?? "").trim()) throw new HttpError(400, "Say briefly why you dispute it.");
    if (body.selected !== undefined) db.prepare("UPDATE cards SET selected = ? WHERE id = ?").run(body.selected ? 1 : 0, c.id);
    if (body.status_interpretation) {
      db.prepare("UPDATE cards SET status_interpretation = ?, dispute_reason = ?, selected = CASE WHEN ? = 'disputed' THEN 0 ELSE selected END WHERE id = ?").run(
        body.status_interpretation, body.status_interpretation === "disputed" ? body.dispute_reason : null, body.status_interpretation, c.id,
      );
    }
    return { ok: true };
  }));

  app.get("/api/cards/:id/evidence", wrap((req) => {
    const c = db.prepare("SELECT * FROM cards WHERE id = ?").get(req.params.id) as any;
    if (!c) throw new HttpError(404, "That card doesn't exist.");
    const ev = db
      .prepare(
        `SELECT ce.*, e.short_id, e.text AS excerpt_text, e.start_offset, e.end_offset, s.id AS source_id, s.kind, s.title, s.url, s.rights, s.match_level, s.author_name,
                s.work, s.locator, s.edition, s.language, s.fetched_at, s.text AS source_text, s.author_id, s.dataset_ref
           FROM card_evidence ce JOIN excerpts e ON e.id = ce.excerpt_id JOIN sources s ON s.id = e.source_id WHERE ce.card_id = ?`,
      )
      .all(c.id) as any[];
    // One entry per source: an item can cite a source twice (once for a quotation, once in support), and the reader should see it once with every matched line lit.
    const bySource = new Map<string, any[]>();
    for (const e of ev) bySource.set(e.source_id, [...(bySource.get(e.source_id) ?? []), e]);
    const usedElsewhereQ = db.prepare(`SELECT DISTINCT st.id, st.display_ref, st.title FROM card_evidence ce2 JOIN excerpts e2 ON e2.id = ce2.excerpt_id JOIN cards c2 ON c2.id = ce2.card_id JOIN studies st ON st.id = c2.study_id
      WHERE e2.source_id = ? AND c2.study_id != ? AND st.primary_ref != (SELECT primary_ref FROM studies WHERE id = ?)`);
    return {
      card: { ...c, flags: json<string[]>(c.flags_json, []) },
      evidence: [...bySource.values()].map((rows) => {
        const e = rows[0];
        const text: string = e.source_text ?? e.excerpt_text;
        const quotes = rows.filter((r) => r.use === "quote" && r.quote_text);
        const matches = quotes.filter((r) => r.match_start != null).map((r) => ({ start: r.match_start as number, end: r.match_end as number }));
        const excerpts = [...new Map(rows.map((r) => [`${r.start_offset}-${r.end_offset}`, { start: r.start_offset as number, end: r.end_offset as number }])).values()];
        const lo = Math.min(...excerpts.map((x) => x.start), ...matches.map((m) => m.start));
        const hi = Math.max(...excerpts.map((x) => x.end), ...matches.map((m) => m.end));
        const winStart = Math.max(0, lo - 1500);
        const winEnd = Math.min(text.length, hi + 1500);
        const author = e.author_id ? (db.prepare("SELECT full_identity, care_note FROM authors WHERE id = ?").get(e.author_id) as any) : null;
        const shift = (x: { start: number; end: number }) => ({ start: x.start - winStart, end: x.end - winStart });
        const best = quotes.find((r) => r.match && r.match !== "not_found") ?? quotes[0] ?? null;
        return {
          id: e.source_id, use: best ? "quote" : e.use, quote: best?.quote_text ?? null, match: best?.match ?? null, nearMatch: quotes.find((r) => r.near_match)?.near_match ?? null, shortId: e.short_id,
          quotes: quotes.map((r) => ({ text: r.quote_text, match: r.match, nearMatch: r.near_match })),
          source: { id: e.source_id, kind: e.kind, title: e.title, url: e.url, rights: e.rights, matchLevel: e.match_level, author: e.author_name, fullIdentity: author?.full_identity ?? null, careNote: author?.care_note ?? null, work: e.work, locator: e.locator, edition: e.edition, language: e.language, fetchedAt: e.fetched_at, word: lexiconWord(e) },
          window: { text: text.slice(winStart, winEnd), offset: winStart, truncatedStart: winStart > 0, truncatedEnd: winEnd < text.length },
          excerpt: shift(excerpts[0]), excerpts: excerpts.map(shift),
          matchSpan: matches[0] ? shift(matches[0]) : null, matchSpans: matches.map(shift),
          usedElsewhere: usedElsewhereQ.all(e.source_id, c.study_id, c.study_id),
        };
      }),
    };
  }));

  app.get("/api/runs/:id/sources", wrap((req) => {
    return db
      .prepare(`SELECT s.id, s.kind, s.title, s.url, s.rights, s.author_name, s.work, s.locator, rs.stage, substr(s.text, 1, 600) AS preview, length(s.text) AS length FROM run_sources rs JOIN sources s ON s.id = rs.source_id WHERE rs.run_id = ? ORDER BY rs.stage`)
      .all(req.params.id);
  }));
  app.get("/api/sources/:id", wrap((req) => {
    const s = db.prepare("SELECT * FROM sources WHERE id = ?").get(req.params.id);
    if (!s) throw new HttpError(404, "Not found.");
    return s;
  }));

  app.post("/api/sources/:id/working-translation", wrap(async (req) => {
    const s = db.prepare("SELECT * FROM sources WHERE id = ?").get(req.params.id) as any;
    const { text, studyId } = z.object({ text: z.string().max(6000), studyId: z.string().nullish() }).parse(req.body);
    const res = await callStructured<{ translation: string; uncertain_words: string[] }>({
      db, stage: "translate", promptVersion: VERSIONS.translate, system: systemPrompt(getPrefs(db)), user: translatePrompt(s?.language === "la" ? "Latin" : s?.language === "grc" ? "Greek" : s?.language === "he" ? "Hebrew" : "source-language", text),
      schema: TRANSLATE_SCHEMA, effort: "medium", maxTokens: 4000, studyId: studyId ?? null,
    });
    return res.data;
  }));

  // ---- Word studies (local data only) ----
  app.get("/api/words/:strong", wrap(async (req) => {
    const strong = z.string().regex(/^[HG]\d{1,4}[A-Za-z]?$/).parse((req.params as any).strong);
    const q = z.object({ at: z.string().max(40).optional(), all: z.string().optional() }).parse(req.query ?? {});
    if (!stepbibleAvailable()) throw new HttpError(409, "The Hebrew and Greek words aren't downloaded yet. Everything else still works; download them in Settings → Data.");
    const padded = strong.replace(/^([HG])(\d+)/, (_m, l: string, n: string) => l + n.padStart(4, "0"));
    const w = await wordStudy(padded, q.at ? fromUsfm(q.at) : null, q.all === "1");
    if (!w) throw new HttpError(404, `There's no lexicon entry for ${strong}. The rest of the study is unaffected.`);
    return w;
  }));
  app.get("/api/studies/:id/words", wrap((req) => {
    const s = getStudy(db, req.params.id);
    if (!stepbibleAvailable()) return { available: false, words: [] };
    const r = fromUsfm(s.primary_ref) as any;
    return { available: true, language: (bookByUsfm(r.book)?.index ?? 1) >= 40 ? "grc" : "he", words: passageWords({ book: r.book, c1: r.c1, v1: r.v1 ?? 1, c2: r.c2, v2: r.v2 ?? 200 }) };
  }));

  // ---- Writing ----
  app.post("/api/studies/:id/title", wrap(async (req) => {
    const s = getStudy(db, req.params.id);
    const body = z.object({ previous: z.array(z.string().max(200)).max(8).default([]) }).parse(req.body ?? {});
    const title = await suggestTitle(db, s.id, body.previous);
    db.prepare("UPDATE studies SET title = ?, title_auto = 1, updated_at = ? WHERE id = ?").run(title, nowIso(), s.id);
    const u = db.prepare("SELECT * FROM studies WHERE id = ?").get(s.id) as any;
    indexEntity(db, "study", u.id, u.id, `${u.display_ref} ${u.title ?? ""}`, [u.question, u.first_observation, u.note].filter(Boolean).join("\n"));
    refreshRecord(db, s.id);
    return { title };
  }));
  app.post("/api/studies/:id/angles", wrap(async (req) => {
    const body = z.object({ previous: z.array(z.string()).max(12).default([]) }).parse(req.body ?? {});
    return findAngles(db, getStudy(db, req.params.id).id, body.previous);
  }));

  app.post("/api/studies/:id/drafts", wrap(async (req) => {
    const s = getStudy(db, req.params.id);
    const body = z.object({ kind: z.enum(["edit", "alternate"]).default("edit"), format: z.enum(WRITING_FORMATS).default(s.format) }).parse(req.body ?? {});
    setPrefs(db, { lastFormat: body.format });
    return draft(db, s.id, body.kind, body.format);
  }));

  app.post("/api/studies/:id/sharpen", wrap(async (req) => {
    const body = z.object({ mode: z.enum(["polish", "shorten", "clarify"]).default("polish"), instruction: z.string().max(1500).optional() }).parse(req.body ?? {});
    return sharpen(db, getStudy(db, req.params.id).id, body);
  }));

  app.post("/api/studies/:id/writing-format", wrap(async (req) => {
    const s = getStudy(db, req.params.id);
    const body = z.object({ format: z.enum(WRITING_FORMATS), base_hash: z.string().nullish() }).parse(req.body);
    const current = getWorkingText(db, s.id);
    if (body.base_hash !== undefined && body.base_hash !== (current?.text_hash ?? null)) throw new HttpError(409, "This draft changed elsewhere. Your saved work is safe; reload before changing its form.");
    const working = switchWritingFormat(db, s.id, body.format);
    setPrefs(db, { lastFormat: body.format });
    refreshRecord(db, s.id);
    const g = await computeGate(db, s.id, working);
    return { working, gate: g.gate, findings: { deterministic: g.deterministic, model: g.model } };
  }));

  app.post("/api/studies/:id/drafts/:draftId/apply", wrap(async (req) => {
    const s = getStudy(db, req.params.id);
    if (!db.prepare("SELECT 1 FROM drafts WHERE id = ? AND study_id = ?").get(req.params.draftId, s.id)) throw new HttpError(404, "That draft doesn't belong to this study. Your writing is unchanged; choose one of this study's drafts.");
    const body = z.object({ base_hash: z.string().nullish(), base_format: z.enum(WRITING_FORMATS).optional() }).parse(req.body ?? {});
    const current = getWorkingText(db, s.id);
    if ((body.base_hash !== undefined && body.base_hash !== (current?.text_hash ?? null)) || (body.base_format && body.base_format !== (current?.format ?? s.format))) throw new HttpError(409, "Your writing changed after this draft opened. Your edits are saved; reopen the suggestion before replacing them.");
    const d = getDraft(db, req.params.draftId);
    const w = saveWorkingText(db, s.id, { format: d.format, parts: d.parts, source_reply: d.source_reply ?? "" }, "draft_applied", d.id);
    refreshRecord(db, s.id);
    const g = await computeGate(db, s.id, w);
    return { working: w, gate: g.gate, findings: { deterministic: g.deterministic, model: g.model } };
  }));

  app.put("/api/studies/:id/working-text", wrap(async (req) => {
    const s = getStudy(db, req.params.id);
    const body = z
      .object({ format: z.enum(WRITING_FORMATS), parts: z.array(z.string().max(50000)).min(1).max(8), source_reply: z.string().max(50000).default(""), base_hash: z.string().nullish(), base_format: z.enum(WRITING_FORMATS).optional(), cause: z.enum(["typing", "repair_applied", "split", "restore", "undo", "sharpen"]).default("typing") })
      .parse(req.body);
    const cur = getWorkingText(db, s.id);
    if ((body.base_hash !== undefined && body.base_hash !== (cur?.text_hash ?? null)) || (body.base_format && body.base_format !== (cur?.format ?? s.format))) {
      throw new HttpError(409, "This text changed somewhere else. Your saved work is safe; reload to see the latest version.");
    }
    const w = saveWorkingText(db, s.id, body, body.cause);
    refreshRecord(db, s.id);
    const det = await deterministicReview(db, s.id, w);
    const g = await computeGate(db, s.id, w, det);
    return { working: w, gate: g.gate, findings: { deterministic: g.deterministic, model: g.model } };
  }));

  app.post("/api/studies/:id/split", wrap((req) => {
    const { text } = z.object({ text: z.string() }).parse(req.body);
    const parts = splitIntoThread(text);
    if (!parts) throw new HttpError(422, "A sentence is longer than 280 characters, or it would take more than four parts. Trim it, or ask for a thread draft.");
    return { parts };
  }));

  app.post("/api/studies/:id/review", wrap(async (req) => {
    const s = getStudy(db, req.params.id);
    await modelReview(db, s.id);
    const g = await computeGate(db, s.id);
    return { gate: g.gate, findings: { deterministic: g.deterministic, model: g.model }, review: g.review };
  }));

  app.patch("/api/findings/:id", wrap((req) => {
    const body = z.object({ resolution: z.enum(["repaired", "kept", "dismissed"]).nullable(), reason: z.string().nullish() }).parse(req.body);
    const f = db.prepare("SELECT * FROM findings WHERE id = ?").get(req.params.id) as any;
    if (!f) throw new HttpError(404, "That finding doesn't exist.");
    if (body.resolution === "kept" && f.severity === "judgment" && wordCount(body.reason ?? "") < 5) throw new HttpError(400, "Give a reason of at least five words for keeping it.");
    if (body.resolution === "kept" && f.severity === "blocker") throw new HttpError(400, "Blockers must be fixed in the text.");
    if (body.resolution === "dismissed" && f.severity !== "suggestion") throw new HttpError(400, "Only suggestions can be dismissed.");
    db.prepare("UPDATE findings SET resolution = ?, resolution_reason = ?, resolved_at = ? WHERE id = ?").run(body.resolution, body.reason ?? null, body.resolution ? nowIso() : null, f.id);
    return { ok: true };
  }));

  app.post("/api/studies/:id/decisions", wrap((req) => {
    const s = getStudy(db, req.params.id);
    const body = z.object({ code: z.string(), span_text: z.string(), resolution: z.enum(["kept", "dismissed"]).nullable(), reason: z.string().nullish() }).parse(req.body);
    if (body.resolution === "kept" && wordCount(body.reason ?? "") < 5) throw new HttpError(400, "Give a reason of at least five words for keeping it.");
    if (body.resolution === null) db.prepare("DELETE FROM finding_decisions WHERE study_id = ? AND check_code = ? AND span_text = ?").run(s.id, body.code, body.span_text);
    else db.prepare("INSERT OR REPLACE INTO finding_decisions (study_id, check_code, span_text, resolution, reason, created_at) VALUES (?,?,?,?,?,?)").run(s.id, body.code, body.span_text, body.resolution, body.reason ?? null, nowIso());
    return { ok: true };
  }));

  // ---- Publishing ----
  app.post("/api/studies/:id/publish", wrap(async (req) => {
    const s = getStudy(db, req.params.id);
    const { confirm_text_hash } = z.object({ confirm_text_hash: z.string() }).parse(req.body);
    return startPublish(db, s.id, confirm_text_hash);
  }));
  app.get("/api/studies/:id/publish", wrap((req) => publishState(db, getStudy(db, req.params.id).id)));
  app.post("/api/posts/:id/receipt", wrap((req) => {
    const { url, published_text } = z.object({ url: z.string(), published_text: z.string().nullish() }).parse(req.body);
    const r = recordReceipt(db, req.params.id, url, published_text);
    if (r.done) refreshRecord(db, (db.prepare("SELECT study_id FROM posts WHERE id = ?").get(req.params.id) as any).study_id);
    return r;
  }));
  app.post("/api/posts/:id/skip", wrap((req) => {
    const r = skipPost(db, req.params.id);
    if (r.done) refreshRecord(db, (db.prepare("SELECT study_id FROM posts WHERE id = ?").get(req.params.id) as any).study_id);
    return r;
  }));

  // ---- Later ----
  app.get("/api/later", wrap(() => {
    return (db.prepare("SELECT l.*, c.title AS card_title, c.body AS card_body, c.author_name, s.display_ref, s.primary_ref FROM later_items l LEFT JOIN cards c ON c.id = l.card_id LEFT JOIN studies s ON s.id = l.study_id ORDER BY l.created_at DESC").all() as any[]).map((r) => ({ ...r, tags: json<string[]>(r.tags_json, []) }));
  }));
  app.post("/api/later", wrap((req) => {
    const body = z.object({ kind: z.enum(["card", "idea", "question", "excerpt"]), card_id: z.string().nullish(), study_id: z.string().nullish(), text: z.string().nullish(), tags: z.array(z.string()).default([]) }).parse(req.body);
    if (body.card_id && db.prepare("SELECT id FROM later_items WHERE card_id = ? AND used_in_study_id IS NULL").get(body.card_id)) return { ok: true, duplicate: true };
    const id = uuidv7();
    db.prepare("INSERT INTO later_items (id, kind, card_id, study_id, text, tags_json, created_at) VALUES (?,?,?,?,?,?,?)").run(id, body.kind, body.card_id ?? null, body.study_id ?? null, body.text ?? null, JSON.stringify(body.tags), nowIso());
    return { id };
  }));
  app.delete("/api/later/:id", wrap((req) => {
    db.prepare("DELETE FROM later_items WHERE id = ?").run(req.params.id);
    return { ok: true };
  }));

  // ---- Activity (human minutes) ----
  app.post("/api/activity", wrap((req) => {
    const { studyId, seconds } = z.object({ studyId: z.string(), seconds: z.number().int().min(1).max(120) }).parse(req.body);
    getStudy(db, studyId);
    db.prepare("INSERT INTO activity (study_id, local_date, active_seconds) VALUES (?,?,?) ON CONFLICT(study_id, local_date) DO UPDATE SET active_seconds = active_seconds + excluded.active_seconds").run(studyId, localDate(), seconds);
    return { ok: true };
  }));

  // ---- Insights ----
  app.get("/api/insights", wrap(() => {
    const studies = db.prepare("SELECT id, created_local_date, note, status, parent_study_id FROM studies WHERE status != 'archived'").all() as any[];
    const completed = studies.filter((s) => s.status === "saved" || s.status === "published");
    const byDay: Record<string, number> = {};
    for (const s of completed) byDay[s.created_local_date] = (byDay[s.created_local_date] ?? 0) + 1;
    const minutes = (db.prepare("SELECT study_id, SUM(active_seconds) a, SUM(research_wait_seconds) w FROM activity GROUP BY study_id").all() as any[]);
    const median = (xs: number[]) => {
      if (!xs.length) return null;
      const s = [...xs].sort((a, b) => a - b);
      const m = Math.floor(s.length / 2);
      return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
    };
    const posts = db.prepare("SELECT p.*, s.display_ref FROM posts p JOIN studies s ON s.id = p.study_id WHERE p.status = 'posted' ORDER BY p.posted_at DESC").all() as any[];
    const month = monthTotals(db);
    const mainThisMonth = posts.filter((p) => p.role === "main" && p.posted_at >= new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString()).length;
    return {
      practice: {
        studiesCompleted: completed.length, byDay, medianHumanMinutes: median(minutes.filter((m) => m.a > 0).map((m) => m.a / 60)),
        medianWaitMinutes: median(minutes.filter((m) => m.w > 0).map((m) => m.w / 60)), costThisMonthMicros: month.totalMicros,
        costPerPostMicros: mainThisMonth ? Math.round(month.totalMicros / mainThisMonth) : null, returnsToPriorWork: studies.filter((s) => s.parent_study_id).length,
      },
      posts: posts.filter((p) => p.role === "main"),
    };
  }));

  // ---- Preferences, keys, datasets, sources ----
  app.get("/api/preferences", wrap(() => getPrefs(db)));
  app.put("/api/preferences", wrap((req) => {
    const patch = z.record(z.string(), z.unknown()).parse(req.body);
    const allowed = Object.fromEntries(Object.entries(patch).filter(([k]) => k in DEFAULT_PREFS));
    if (typeof allowed.xHandle === "string") allowed.xHandle = (allowed.xHandle as string).replace(/^@/, "").trim();
    if (allowed.budgets !== undefined) {
      const money = z.number().finite().nonnegative();
      const budgets = z.object({ perRunUsd: money.optional(), perStudyUsd: money.optional(), monthlyOpenaiUsd: money.optional(), monthlyXUsd: money.optional() }).strict().parse(allowed.budgets);
      allowed.budgets = { ...getPrefs(db).budgets, ...budgets };
    }
    setPrefs(db, allowed as any);
    return getPrefs(db);
  }));

  /** What an X draft learns your voice from: your own posts in other studies, and posts you like (Settings → Writing). */
  app.get("/api/voice", wrap((req) => {
    const { except } = z.object({ except: z.string().optional() }).parse(req.query);
    const { ownPosts } = voiceSamples(db, except ?? null);
    return { own: ownPosts, liked: getPrefs(db).approvedExamples };
  }));

  app.put("/api/keys/:name", wrap((req) => {
    const name = z.enum(["openai_api_key"]).parse(req.params.name);
    const { value } = z.object({ value: z.string().nullable() }).parse(req.body);
    setSecret(name, value?.trim() || null);
    return { ok: true, present: hasSecret(name) };
  }));
  app.post("/api/keys/:name/test", wrap(async (req) => {
    z.enum(["openai_api_key"]).parse(req.params.name);
    return testOpenaiKey();
  }));

  app.get("/api/datasets", wrap(() => datasetStatus()));
  app.post("/api/datasets/:name/download", wrap((req) => {
    const name = z.enum(Object.keys(DATASETS) as [DatasetName, ...DatasetName[]]).parse(req.params.name);
    void downloadDataset(name);
    return { ok: true };
  }));

  app.get("/api/authors", wrap(() => db.prepare("SELECT * FROM authors ORDER BY is_preferred DESC, preference_rank, display_name").all()));
  app.patch("/api/authors/:id", wrap((req) => {
    const b = z.object({ is_preferred: z.boolean().optional(), preference_rank: z.number().int().nullish(), care_note: z.string().nullish() }).parse(req.body);
    const a = db.prepare("SELECT * FROM authors WHERE id = ?").get(req.params.id) as any;
    if (!a) throw new HttpError(404, "Not found.");
    db.prepare("UPDATE authors SET is_preferred = ?, preference_rank = ?, care_note = ?, updated_at = ? WHERE id = ?").run(
      b.is_preferred === undefined ? a.is_preferred : b.is_preferred ? 1 : 0, b.preference_rank === undefined ? a.preference_rank : b.preference_rank, b.care_note === undefined ? a.care_note : b.care_note, nowIso(), a.id,
    );
    return { ok: true };
  }));
  app.get("/api/domains", wrap(() => db.prepare("SELECT * FROM domains ORDER BY policy, host").all()));

  app.get("/api/costs", wrap(() => ({ month: monthTotals(db), recent: db.prepare("SELECT * FROM cost_ledger ORDER BY occurred_at DESC LIMIT 50").all() })));
  app.get("/api/logs", wrap(() => tailLog(200)));

  // ---- Corrections ----
  app.post("/api/corrections", wrap((req) => {
    const b = z.object({ study_id: z.string(), what_changed: z.string().min(1), revised_understanding: z.string().min(1), affected_post_ids: z.array(z.string()) }).parse(req.body);
    getStudy(db, b.study_id);
    db.transaction(() => {
      db.prepare("INSERT INTO corrections (id, study_id, what_changed, revised_understanding, affected_post_ids_json, created_at) VALUES (?,?,?,?,?,?)").run(uuidv7(), b.study_id, b.what_changed, b.revised_understanding, JSON.stringify(b.affected_post_ids), nowIso());
      db.prepare("UPDATE studies SET endorsement = 'revised', updated_at = ? WHERE id = ?").run(nowIso(), b.study_id);
    })();
    return { ok: true };
  }));

  // ---- Records, export, backups ----
  app.get("/api/studies/:id/corpus", wrap((req, reply) => {
    getStudy(db, req.params.id);
    reply.header("Cache-Control", "no-store");
    return inspectResearchCorpus(db, req.params.id);
  }));
  app.post("/api/studies/:id/corpus/review", wrap((req, reply) => {
    getStudy(db, req.params.id);
    const body = z.object({
      expectedHash: z.string().regex(/^[a-f0-9]{64}$/),
      reviewedPrivacy: z.literal(true), reviewedQuality: z.literal(true), reviewedRights: z.literal(true),
      sourceRights: z.array(z.object({ sourceId: z.string(), licenseUrl: z.url(), attribution: z.string().min(1), provenanceUrl: z.url() })),
    }).strict().parse(req.body);
    reply.header("Cache-Control", "no-store");
    return approveResearchCorpus(db, req.params.id, body);
  }));
  app.post("/api/studies/:id/corpus/revoke", wrap((req, reply) => {
    getStudy(db, req.params.id);
    const body = z.object({ expectedHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(req.body);
    reply.header("Cache-Control", "no-store");
    return revokeResearchCorpus(db, req.params.id, body);
  }));
  app.get("/api/studies/:id/corpus.json", wrap((req, reply) => {
    const s = getStudy(db, req.params.id);
    const exported = buildResearchCorpusExport(db, s.id);
    reply.header("Cache-Control", "no-store");
    reply.header("Content-Disposition", `attachment; filename="${s.display_ref.replace(/[^a-zA-Z0-9 -]/g, "-")}-research.json"`);
    return reply.type("application/json").send(JSON.stringify(exported, null, 2));
  }));

  app.get("/api/studies/:id/export.json", wrap(async (req, reply) => {
    const s = getStudy(db, req.params.id);
    const exported = buildStudyExport(db, s.id);
    reply.header("Cache-Control", "no-store");
    reply.header("Content-Disposition", `attachment; filename="${s.display_ref.replace(/[^a-zA-Z0-9 -]/g, "-")}-study.json"`);
    return reply.type("application/json").send(JSON.stringify(exported, null, 2));
  }));

  app.get("/api/studies/:id/export.md", wrap(async (req, reply) => {
    const s = getStudy(db, req.params.id);
    const md = await studyMarkdown(db, s.id);
    reply.header("Content-Type", "text/markdown; charset=utf-8").header("Content-Disposition", `attachment; filename="${s.display_ref.replace(/[^\w]+/g, "-")}.md"`);
    return md;
  }));

  app.get("/api/records", wrap(() => ({
    notesDir: NOTES_DIR, notesWhere: friendlyPath(NOTES_DIR),
    count: (db.prepare("SELECT COUNT(*) n FROM studies WHERE record_path IS NOT NULL").get() as any).n,
    backupDir: friendlyPath(BACKUP_DIR), backups: listBackups(),
  })));
  app.post("/api/records/rebuild", wrap(async () => writeAllRecords(db)));
  app.post("/api/records/reveal", wrap((req) => {
    const { which } = z.object({ which: z.enum(["notes", "backups"]) }).parse(req.body);
    const dir = which === "notes" ? NOTES_DIR : BACKUP_DIR;
    fs.mkdirSync(dir, { recursive: true });
    if (process.env.COMMENTARY_TEST !== "1") execFile("open", [dir]);
    return { ok: true };
  }));
  app.post("/api/backups", wrap(async () => {
    try {
      return await backupNow(db);
    } catch (e) {
      throw new HttpError(500, `The backup didn't finish (${(e as Error).message}). Your data is unchanged; try again, or check free disk space.`);
    }
  }));
}
