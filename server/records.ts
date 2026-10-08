// The durable, readable record of a study: one Markdown file per study under ~/Documents/Personal Commentary/<Book>/.
// The database stays the source of truth; these files are what you can open, search, and keep without the app.
import fs from "node:fs";
import path from "node:path";
import type { DB } from "./db.ts";
import { json, nowIso } from "./db.ts";
import { APP_NAME, NOTES_DIR } from "./config.ts";
import { getChapter } from "./bible.ts";
import { getWorkingText, getWorkingTextVariants, currentBriefCards, sectionOf, studyNotes } from "./writing.ts";
import { bookByUsfm, fromUsfm } from "../shared/refs.ts";
import { isXFormat, WRITING_LABELS } from "../shared/writing.ts";
import { log } from "./log.ts";

const FORMAT_WORD: Record<string, string> = { single: "single post", long: "long post", thread: "thread" };
/** Pieces in reading order: the post (the idea in brief), then the longer pieces. */
const PIECE_ORDER = ["single", "long", "thread", "notes", "journal", "devotional"];

/** A note written for people: each kept line (">") set apart as its own quotation, never run into a paragraph. */
export function readableNotes(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  for (const line of lines) {
    const kept = /^\s*>/.test(line);
    const prev = out.at(-1);
    // A blank line wherever your words and a kept line meet; two kept lines in a row are two quotations.
    if (prev?.trim() && (kept || /^>/.test(prev))) out.push("");
    out.push(kept ? line.replace(/^\s*>\s?/, "> ") : line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** A piece's own headings, one level down, so they sit under the record's heading for the piece. */
const nestHeadings = (text: string) => text.replace(/^(#{1,5})(?=\s)/gm, "#$1");

async function passageLines(s: any): Promise<string[]> {
  const r = fromUsfm(s.primary_ref);
  if (!r) return [];
  const lines: string[] = [];
  try {
    for (let c = r.c1; c <= r.c2; c++) {
      const ch = await getChapter({ id: s.translation_id }, r.book, c);
      for (const v of ch.verses) {
        const afterStart = c > r.c1 || r.v1 === null || v.n >= r.v1;
        const beforeEnd = c < r.c2 || r.v2 === null || v.n <= r.v2;
        if (afterStart && beforeEnd) lines.push(`> **${r.c1 === r.c2 ? v.n : `${c}:${v.n}`}** ${v.text}`);
      }
    }
  } catch {
    return [];
  }
  return lines.length ? [...lines, ">", `> — ${s.display_ref} (${s.translation_id})`] : [];
}

const SECTION_HEADS: [string, string][] = [
  ["scripture", "Scripture on Scripture"], ["christ", "How it points to Jesus"], ["language", "The original words"], ["history", "History"],
  ["culture", "Culture"], ["commentary", "What the voices say"], ["tradition", "Also in the tradition"], ["where", "Notes on the text"],
];

/** The study as Markdown: the passage, your words, every saved writing form, and the whole study brief. */
export async function studyMarkdown(db: DB, studyId: string): Promise<string> {
  const s = db.prepare("SELECT * FROM studies WHERE id = ?").get(studyId) as any;
  const wt = getWorkingText(db, studyId);
  const variants = getWorkingTextVariants(db, studyId)
    .filter((v) => v.parts.some((p) => p.trim()))
    .sort((a, b) => Number(b.format === wt?.format) - Number(a.format === wt?.format));
  const posted = db.prepare("SELECT * FROM posts WHERE study_id = ? AND status = 'posted' ORDER BY sequence").all(studyId) as any[];
  const cards = currentBriefCards(db, studyId);
  const brief = db.prepare("SELECT context_summary, qualification FROM research_runs WHERE study_id = ? AND context_summary IS NOT NULL ORDER BY queued_at DESC LIMIT 1").get(studyId) as any;
  const runBriefs = (db.prepare("SELECT brief_json FROM research_runs WHERE study_id = ? ORDER BY queued_at DESC").all(studyId) as any[]).map((r) => json<any>(r.brief_json, {}));
  const where = runBriefs.find((b) => b.where)?.where;
  const christSummary = runBriefs.find((b) => b.christ_summary)?.christ_summary;
  // The passage itself is at the top of the record; list only the other sources each item rests on.
  const sourcesFor = db.prepare("SELECT DISTINCT s.title, s.url FROM card_evidence ce JOIN excerpts e ON e.id = ce.excerpt_id JOIN sources s ON s.id = e.source_id WHERE ce.card_id = ? AND s.kind != 'bible_text'");
  const quoteOf = db.prepare("SELECT quote_text FROM card_evidence WHERE card_id = ? AND use = 'quote' AND match IN ('exact','loose','elided') AND quote_text IS NOT NULL LIMIT 1");
  const tags = json<string[]>(s.tags_json, []);
  const yaml = (v: string) => JSON.stringify(v); // JSON strings are valid YAML scalars

  const out: string[] = [
    "---",
    `reference: ${yaml(s.display_ref)}`,
    ...(s.title ? [`title: ${yaml(s.title)}`] : []),
    `translation: ${s.translation_id}`,
    `status: ${s.status}`,
    `studied: ${s.created_local_date}`,
    ...(s.saved_at ? [`saved: ${s.saved_at}`] : []),
    ...(wt ? [`format: ${wt.format}`] : []),
    ...(variants.length > 1 ? [`saved_formats: [${variants.map((v) => v.format).join(", ")}]`] : []),
    ...(posted.length ? ["posts:", ...posted.filter((p) => p.x_url).map((p) => `  - ${p.x_url}`)] : []),
    `tags: [${tags.map(yaml).join(", ")}]`,
    `id: ${s.id}`,
    `app: ${yaml(APP_NAME)}`,
    "---",
    "",
    `# ${s.display_ref}${s.title ? ` — ${s.title}` : ""}`,
    "",
    ...(await passageLines(s)),
    "",
  ];
  if (s.question) out.push("## Question", "", s.question, "");

  // What you made comes first: the post (the idea in brief), then the longer pieces.
  if (posted.length) {
    out.push("## Posted to X", "");
    for (const p of posted) {
      const label = p.role === "main" ? "Post" : p.role === "source_reply" ? "Sources reply" : `Part ${p.sequence + 1}`;
      out.push(`**${label}** · [view on X](${p.x_url})`, "", p.published_text ?? p.text, "");
    }
  }
  for (const draft of [...variants].sort((a, b) => PIECE_ORDER.indexOf(a.format) - PIECE_ORDER.indexOf(b.format))) {
    const parts = draft.parts.filter((p) => p.trim());
    const xFormat = isXFormat(draft.format);
    // Keep the published receipt and any different draft together without repeating an unchanged published draft.
    const publishedParts = posted.filter((p) => p.batch_hash === draft.text_hash && (p.role === "main" || p.role === "thread_part"));
    const alreadyPosted = xFormat && publishedParts.length === parts.length && publishedParts.every((p, i) => (p.published_text ?? p.text).trim() === parts[i].trim());
    if (alreadyPosted) continue;
    const head = !xFormat ? WRITING_LABELS[draft.format]
      : posted.length ? `Saved draft (${WRITING_LABELS[draft.format]})`
      : `The post (${FORMAT_WORD[draft.format]}${parts.length > 1 ? `, ${parts.length} parts` : ""}, not yet posted)`;
    out.push(`## ${head}`, "");
    parts.forEach((p, i) => out.push(...(parts.length > 1 ? [`**${i + 1}/${parts.length}**`, ""] : []), xFormat ? p : nestHeadings(p), ""));
    if (xFormat && draft.source_reply?.trim()) out.push("**Sources reply**", "", draft.source_reply.trim(), "");
  }

  // The notebook as you wrote it, then the findings you highlighted.
  const notes = studyNotes(s);
  out.push("## Notes", "", notes ? readableNotes(notes) : "_Nothing written yet._", "");
  const highlighted = cards.filter((c) => c.selected);
  if (highlighted.length) {
    out.push("## Highlights", "");
    for (const c of highlighted) {
      const q = (quoteOf.get(c.id) as any)?.quote_text;
      out.push(`- **${c.title}**${c.author_name ? ` — ${c.author_name}` : ""}`, ...(q ? ["", `  > “${q}”`, ""] : []));
    }
    out.push("");
  }

  if (cards.length || where) {
    out.push("## Study brief", "");
    if (where) {
      out.push("### Where this sits", "");
      for (const k of ["book", "section", "flow", "this_verse"]) if (where[k]) out.push(where[k], "");
    }
    for (const [key, head] of SECTION_HEADS) {
      const these = cards.filter((c) => sectionOf(c) === key);
      if (!these.length && !(key === "christ" && christSummary)) continue;
      out.push(`### ${head}`, "");
      if (key === "christ" && christSummary) out.push(christSummary, "");
      for (const c of these) {
        const data = json<any>(c.data_json, {});
        const word = data.strong ? ` (${data.lemma}, ${data.translit}, ${data.strong})` : "";
        out.push(`#### ${c.selected ? "★ " : ""}${c.title}${word}${c.author_name ? ` — ${c.author_name}` : ""}`, "", c.body, "");
        if (data.strong && data.definition) out.push(`> ${data.definition.split("\n").slice(0, 4).join(" ")}`, "");
        for (const x of sourcesFor.all(c.id) as any[]) out.push(`- ${x.url ? `[${x.title}](${x.url})` : x.title}`);
        out.push("");
      }
    }
    if (cards.some((c) => c.selected)) out.push("_★ marks what I highlighted._", "");
  }
  if (brief?.qualification) out.push(`_Study qualification: ${brief.qualification}_`, "");
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

/** `2026-10-01 Exodus 33.3.md` under the book's folder. Colons become dots: Finder shows ":" as "/". */
function recordPathFor(s: any): string {
  const book = bookByUsfm(s.primary_ref.split(".")[0])?.name ?? "Other";
  const name = `${s.created_local_date} ${s.display_ref}`.replace(/:/g, ".").replace(/[/\\?%*|"<>]/g, "-");
  const dir = path.join(NOTES_DIR, book);
  let file = path.join(dir, `${name}.md`);
  // Two studies of the same passage on the same day get "(2)", "(3)", … — never another study's file.
  for (let n = 2; fs.existsSync(file) && !fs.readFileSync(file, "utf8").includes(`\nid: ${s.id}\n`); n++) file = path.join(dir, `${name} (${n}).md`);
  return file;
}

/** Writes (or rewrites) the study's record and remembers where it is. */
export async function writeRecord(db: DB, studyId: string, opts: { saved?: boolean } = {}): Promise<string> {
  if (opts.saved) db.prepare("UPDATE studies SET saved_at = ? WHERE id = ?").run(nowIso(), studyId);
  const s = db.prepare("SELECT * FROM studies WHERE id = ?").get(studyId) as any;
  const md = await studyMarkdown(db, studyId);
  // Only rewrite a file inside this instance's notes folder. A copied database (a test or sandbox instance)
  // still carries the original's paths, and must never write into the user's real Documents folder.
  const insideNotes = (p: string) => path.resolve(p).startsWith(path.resolve(NOTES_DIR) + path.sep);
  const prev: string | null = s.record_path && insideNotes(s.record_path) && fs.existsSync(s.record_path) ? s.record_path : null;
  const file = prev ?? recordPathFor(s);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, md);
  fs.renameSync(tmp, file);
  if (file !== s.record_path) db.prepare("UPDATE studies SET record_path = ? WHERE id = ?").run(file, studyId);
  log("info", "records", "written", { study: studyId });
  return file;
}

/** Keeps an existing record current after a change; studies that were never saved or posted get no file. */
export function refreshRecord(db: DB, studyId: string) {
  const s = db.prepare("SELECT record_path, status FROM studies WHERE id = ?").get(studyId) as any;
  if (!s || !(s.record_path || s.status === "published")) return;
  writeRecord(db, studyId).catch((e) => log("warn", "records", "write_failed", { study: studyId, error: String(e) }));
}

/** Writes a record for every saved or posted study (for studies saved before records existed). */
export async function writeAllRecords(db: DB): Promise<{ written: number; dir: string }> {
  const ids = db.prepare("SELECT id FROM studies WHERE status IN ('saved','published')").all() as { id: string }[];
  for (const { id } of ids) await writeRecord(db, id);
  return { written: ids.length, dir: NOTES_DIR };
}

/** Where a path sits, written for people: "Documents/Personal Commentary/Exodus". */
export function friendlyPath(p: string): string {
  const home = process.env.HOME ?? "";
  return home && p.startsWith(home + path.sep) ? p.slice(home.length + 1) : p;
}
