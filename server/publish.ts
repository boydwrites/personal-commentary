// Publishing through X's composer. Nothing posts without an explicit click on the exact reviewed text (R5).
import type { DB } from "./db.ts";
import { uuidv7, nowIso, sha256, indexEntity } from "./db.ts";
import { getPrefs } from "./prefs.ts";
import { computeGate } from "./review.ts";
import { getWorkingText } from "./writing.ts";
import { countPost, findUrls } from "../shared/counting.ts";
import { gatingForm, normalize } from "../shared/text.ts";
import { isXFormat } from "../shared/writing.ts";

export class PublishError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function startPublish(db: DB, studyId: string, confirmHash: string) {
  const w = getWorkingText(db, studyId);
  if (!w) throw new PublishError(400, "There's nothing to publish yet.");
  if (!isXFormat(w.format)) throw new PublishError(400, "This writing format isn't an X post. Your draft is saved; choose an X format to prepare a separate post.");
  const { gate } = await computeGate(db, studyId, w);
  if (w.text_hash !== confirmHash) throw new PublishError(409, "The text changed after you opened Publish. Review it again.");
  if (!gate.canPublish) throw new PublishError(409, gate.reasons.join(" · "));
  const prefs = getPrefs(db);
  const review = db.prepare("SELECT id FROM reviews WHERE study_id = ? AND kind = 'model' ORDER BY created_at DESC LIMIT 1").get(studyId) as any;

  // An unfinished batch for the same text resumes instead of creating duplicates.
  const existing = db.prepare("SELECT COUNT(*) n FROM posts WHERE study_id = ? AND batch_hash = ?").get(studyId, w.text_hash) as any;
  if (!existing.n) {
    const now = nowIso();
    const ins = db.prepare(
      `INSERT INTO posts (id, study_id, role, sequence, text, text_hash, batch_hash, review_id, channel, status, weighted_length, contains_url, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    db.transaction(() => {
      const items = w.parts.map((text, i) => ({ role: i === 0 ? "main" : "thread_part", text }));
      if (prefs.postSourceReply && w.source_reply.trim()) items.push({ role: "source_reply", text: w.source_reply });
      items.forEach((it, i) => {
        const text = cleanForPost(it.text);
        ins.run(uuidv7(), studyId, it.role, i, text, sha256(gatingForm([text], "")), w.text_hash, review?.id ?? null, "composer", "ready", countPost(text, w.format === "long" ? "long" : "single").weightedLength, findUrls(text).length ? 1 : 0, now, now);
      });
    })();
  }
  return publishState(db, studyId);
}

/** Formatting applied before publishing (§19.2). */
export function cleanForPost(text: string) {
  return text.replace(/[ \t]+$/gm, "").replace(/\n{4,}/g, "\n\n\n").trim();
}

export function publishState(db: DB, studyId: string) {
  const prefs = getPrefs(db);
  const w = getWorkingText(db, studyId);
  const batch = (db.prepare("SELECT batch_hash FROM posts WHERE study_id = ? ORDER BY created_at DESC LIMIT 1").get(studyId) as any)?.batch_hash;
  if (!batch) return { posts: [], next: null, done: false };
  const posts = db.prepare("SELECT * FROM posts WHERE study_id = ? AND batch_hash = ? ORDER BY sequence").all(studyId, batch) as any[];
  const nextPost = posts.find((p) => p.status === "ready");
  let next: null | { postId: string; role: string; intentUrl: string; mode: "intent" | "clipboard"; text: string; replyTo: string | null } = null;
  if (nextPost && w && isXFormat(w.format) && w.text_hash === batch) {
    const prev = posts.filter((p) => p.sequence < nextPost.sequence && p.status === "posted").at(-1);
    const replyTo = nextPost.sequence > 0 ? prev?.x_post_id ?? null : null;
    const long = nextPost.weighted_length > 280;
    const params = new URLSearchParams({ text: nextPost.text });
    if (replyTo) params.set("in_reply_to", replyTo);
    next = {
      postId: nextPost.id,
      role: nextPost.role,
      text: nextPost.text,
      replyTo,
      mode: long ? "clipboard" : "intent",
      intentUrl: long ? (replyTo ? `https://x.com/${prefs.xHandle}/status/${replyTo}` : "https://x.com/compose/post") : `https://x.com/intent/tweet?${params.toString()}`,
    };
  }
  const done = posts.length > 0 && posts.every((p) => p.status === "posted" || p.status === "skipped");
  return { posts, next, done, stale: !!w && w.text_hash !== batch };
}

export function parseStatusUrl(url: string): { handle: string; id: string } | null {
  const m = url.trim().match(/^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status(?:es)?\/(\d{5,25})/);
  return m ? { handle: m[1], id: m[2] } : null;
}

export function recordReceipt(db: DB, postId: string, url: string, publishedText?: string | null) {
  const post = db.prepare("SELECT * FROM posts WHERE id = ?").get(postId) as any;
  if (!post) throw new PublishError(404, "That post record doesn't exist.");
  const parsed = parseStatusUrl(url);
  if (!parsed) throw new PublishError(400, "That doesn't look like a post link. It should look like https://x.com/yourhandle/status/1234567890.");
  const prefs = getPrefs(db);
  if (prefs.xHandle && parsed.handle.toLowerCase() !== prefs.xHandle.toLowerCase()) {
    throw new PublishError(400, `That link is from @${parsed.handle}, not @${prefs.xHandle}. Check the account, or change the handle in Settings → X.`);
  }
  const dup = db.prepare("SELECT id FROM posts WHERE x_post_id = ? AND id != ?").get(parsed.id, postId);
  if (dup) throw new PublishError(400, "That post link is already recorded for another part.");
  const mismatch = publishedText != null && normalize(publishedText).text !== normalize(post.text).text;
  const now = nowIso();
  db.transaction(() => {
    db.prepare("UPDATE posts SET status = 'posted', x_post_id = ?, x_url = ?, posted_at = ?, published_text = ?, text_mismatch = ?, updated_at = ? WHERE id = ?").run(
      parsed.id, `https://x.com/${parsed.handle}/status/${parsed.id}`, now, mismatch ? publishedText : null, mismatch ? 1 : 0, now, postId,
    );
    if (post.role === "main") indexEntity(db, "x_post", postId, post.study_id, "", publishedText ?? post.text);
  })();
  const state = publishState(db, post.study_id);
  if (state.done) db.prepare("UPDATE studies SET status = 'published', updated_at = ? WHERE id = ?").run(now, post.study_id);
  return state;
}

export function skipPost(db: DB, postId: string) {
  const post = db.prepare("SELECT * FROM posts WHERE id = ?").get(postId) as any;
  if (!post) throw new PublishError(404, "That post record doesn't exist.");
  if (post.role !== "source_reply") throw new PublishError(400, "Only the source reply can be skipped; thread parts publish in order.");
  db.prepare("UPDATE posts SET status = 'skipped', updated_at = ? WHERE id = ?").run(nowIso(), postId);
  const state = publishState(db, post.study_id);
  if (state.done) db.prepare("UPDATE studies SET status = 'published', updated_at = ? WHERE id = ?").run(nowIso(), post.study_id);
  return state;
}
