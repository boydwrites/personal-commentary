// A source is the evidence that a particular run saw. Later retrievals must never rewrite it.
import { nowIso, sha256, uuidv7, type DB } from "../db.ts";

export interface SourceInput {
  kind: string; datasetRef: string; url?: string | null; title: string; authorId?: string | null; authorName?: string | null; work?: string | null;
  locator?: string | null; edition?: string | null; language?: string; rights: string; matchLevel: string; httpStatus?: number | null; text: string; discoveredBy: string;
}

const SNAPSHOT_FIELDS = ["kind", "url", "title", "author_id", "author_name", "work", "locator", "edition", "language", "rights", "match_level", "http_status", "text", "discovered_by"] as const;
const fingerprint = (source: Record<string, unknown>) => sha256(JSON.stringify(SNAPSHOT_FIELDS.map((field) => source[field] ?? null)));

/** Reuse identical evidence; changed text, attribution, edition, or rights gets a new immutable row. */
export function storeSourceSnapshot(db: DB, input: SourceInput): string {
  const source = {
    kind: input.kind, url: input.url ?? null, title: input.title, author_id: input.authorId ?? null, author_name: input.authorName ?? null,
    work: input.work ?? null, locator: input.locator ?? null, edition: input.edition ?? null, language: input.language ?? "en",
    rights: input.rights, match_level: input.matchLevel, http_status: input.httpStatus ?? null, text: input.text, discovered_by: input.discoveredBy,
  };
  const snapshotHash = fingerprint(source);
  const datasetRef = `${input.datasetRef}#snapshot=${snapshotHash}`;
  return db.transaction(() => {
    // Keep legacy unversioned rows intact. Backfilling their derived hash cannot restore text overwritten before this fix.
    const legacy = db.prepare("SELECT * FROM sources WHERE dataset_ref = ?").get(input.datasetRef) as Record<string, any> | undefined;
    if (legacy) {
      if (!legacy.content_hash && legacy.text != null) db.prepare("UPDATE sources SET content_hash = ? WHERE id = ?").run(sha256(legacy.text), legacy.id);
      if (fingerprint(legacy) === snapshotHash) return legacy.id as string;
    }
    const existing = db.prepare("SELECT id FROM sources WHERE dataset_ref = ?").get(datasetRef) as { id: string } | undefined;
    if (existing) return existing.id;
    const id = uuidv7();
    db.prepare(
      `INSERT INTO sources (id, kind, url, dataset_ref, title, author_id, author_name, work, locator, edition, language, rights, match_level, http_status, content_hash, text, fetched_at, discovered_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(id, source.kind, source.url, datasetRef, source.title, source.author_id, source.author_name, source.work, source.locator, source.edition,
      source.language, source.rights, source.match_level, source.http_status, sha256(source.text), source.text, nowIso(), source.discovered_by);
    return id;
  })();
}
