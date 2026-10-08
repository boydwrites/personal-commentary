// Card verification: deterministic, no model calls. "De-quote, don't delete."
import type { DB } from "./db.ts";
import { json } from "./db.ts";
import { findQuotations, matchQuotation, dequoteSpan, wordCount, normalize } from "../shared/text.ts";

export interface ExcerptRow {
  id: string;
  short_id: string;
  source_id: string;
  text: string;
  refs_json: string;
  kind: string;
  source_text: string | null;
  match_level: string;
  author_name: string | null;
  http_status: number | null;
  source_locator: string | null;
}

export function verseMarkerRegex(c: number, v: number): RegExp {
  return new RegExp(`(\\b${c}\\s?[:.]\\s?${v}\\b)|(\\bver(?:se|\\.)?\\s+${v}\\b)|(^|\\n)\\(?${v}[.)]\\s`, "i");
}

export interface CardVerification {
  body: string;
  status_source: "found" | "unavailable" | "not_applicable";
  status_quote: "none" | "matched" | "matched_compiled" | "working_translation" | "dequoted";
  relationship: string;
  flags: string[];
  evidence: { excerpt_id: string; use: string; quote_text: string | null; match: string | null; match_start: number | null; match_end: number | null; near_match: string | null }[];
}

/**
 * Verifies one card against the run's excerpts. `unit` is the study's own verse list used for the
 * direct-commentary sanity rule; `knownAuthors` decides the "not in your directory" flag.
 */
export function verifyCard(
  card: { body: string; relationship: string; author: string | null; evidence: { excerpt_id: string; use: string; quote: string | null }[] },
  excerpts: Map<string, ExcerptRow>,
  unit: { book: string; verses: { c: number; v: number }[] },
  knownAuthors: (name: string) => { care_note: string | null; condemned: boolean } | null,
  wordRange: [number, number] = [25, 90],
): CardVerification {
  const flags: string[] = [];
  let body = card.body;
  const evidence: CardVerification["evidence"] = [];
  let anyFailed = false;
  let anyMatched = false;
  let anyCompiled = false;
  let anyWorking = false;

  const cited: ExcerptRow[] = [];
  for (const ev of card.evidence) {
    const ex = excerpts.get(ev.excerpt_id);
    if (!ex) {
      flags.push(`Cited ${ev.excerpt_id}, which isn't in the evidence; that citation was dropped.`);
      continue;
    }
    cited.push(ex);
    const full = ex.source_text ?? ex.text;
    let match: string | null = null;
    let ms: number | null = null;
    let me: number | null = null;
    let near: string | null = null;
    if (ev.use === "quote" && ev.quote) {
      if (ex.match_level === "working_translation") {
        anyWorking = true;
        match = "not_found";
        flags.push("Quotation from a working translation isn't allowed; changed to paraphrase.");
        body = dequoteSpan(body, ev.quote);
      } else {
        const m = matchQuotation(ev.quote, full);
        match = m.level;
        if (m.level === "not_found") {
          anyFailed = true;
          near = m.nearMatch ?? null;
          body = dequoteSpan(body, ev.quote);
          flags.push(near ? `Quotation changed to paraphrase: near match only — the source reads “${near}”.` : "Quotation changed to paraphrase: wording not found in the source.");
        } else {
          anyMatched = true;
          ms = m.start ?? null;
          me = m.end ?? null;
          if (ex.match_level === "compiled_excerpt") anyCompiled = true;
          if (m.level === "loose") flags.push("Quote matched; punctuation differs from the source.");
          if (m.level === "elided") flags.push("Quote matched with an ellipsis.");
        }
      }
    }
    evidence.push({ excerpt_id: ex.id, use: ev.use, quote_text: ev.quote, match, match_start: ms, match_end: me, near_match: near });
  }

  // Any quotation marks left in the body must match something the card cites (or any Scripture in the run).
  for (const q of findQuotations(body)) {
    const inner = q.inner.trim();
    if (wordCount(inner) < 1) continue;
    const ok = cited.some((ex) => matchQuotation(inner, ex.source_text ?? ex.text).level !== "not_found") ||
      [...excerpts.values()].some((ex) => ex.match_level === "scripture" && matchQuotation(inner, ex.source_text ?? ex.text).level !== "not_found");
    if (!ok && wordCount(inner) <= 2) {
      // A word or two in quotation marks is emphasis, not a quotation: drop the marks quietly (R2 still holds).
      body = dequoteSpan(body, inner);
    } else if (!ok) {
      anyFailed = true;
      body = dequoteSpan(body, inner);
      flags.push(`Quotation changed to paraphrase: “${inner.slice(0, 60)}${inner.length > 60 ? "…" : ""}” wasn't found in the cited sources.`);
    } else anyMatched = true;
  }

  const hasQuotes = card.evidence.some((e) => e.use === "quote") || anyMatched || anyFailed;
  const status_quote: CardVerification["status_quote"] = !hasQuotes ? "none" : anyFailed ? "dequoted" : anyWorking ? "working_translation" : anyCompiled ? "matched_compiled" : "matched";

  let status_source: CardVerification["status_source"] = "found";
  if (card.relationship === "editor_synthesis" && cited.every((e) => e.match_level === "scripture")) status_source = "not_applicable";
  else if (!cited.length || cited.some((e) => !(e.source_text ?? e.text) || (e.http_status !== null && e.http_status !== 200))) status_source = cited.length ? "unavailable" : "unavailable";

  let relationship = card.relationship;
  if (relationship === "direct_commentary") {
    const direct = cited.some((ex) => {
      const refs = json<{ c: number; v: number; v2?: number }[]>(ex.refs_json, []);
      if (refs.some((r) => unit.verses.some((u) => u.c === r.c && u.v >= r.v && u.v <= (r.v2 ?? r.v)))) return true;
      return unit.verses.some((u) => verseMarkerRegex(u.c, u.v).test(ex.text));
    });
    if (!direct) {
      const mentions = cited.some((ex) => unit.verses.some((u) => verseMarkerRegex(u.c, u.v).test(ex.source_text ?? "")));
      relationship = mentions ? "cited_elsewhere" : "thematic_parallel";
      flags.push(`Relationship changed from direct commentary to ${relationship === "cited_elsewhere" ? "cited elsewhere" : "thematic parallel"}: the cited text doesn't comment on this verse.`);
    }
  }
  if (relationship === "scripture_connection" && !cited.some((e) => e.match_level === "scripture")) {
    flags.push("Connection without Scripture text.");
  }
  if (card.author) {
    const a = knownAuthors(card.author);
    if (!a) flags.push("Author not in your directory.");
    else {
      if (a.care_note) flags.push(`Care: ${a.care_note}`);
      if (a.condemned) flags.push("Care: some of this author's teaching was condemned by a church council.");
    }
  }
  const wc = wordCount(body);
  if (wc < wordRange[0] || wc > wordRange[1]) flags.push(`Body is ${wc} words (expected ${wordRange[0]}–${wordRange[1]}).`);

  return { body, status_source, status_quote, relationship, flags, evidence };
}

/** Brief prose (where this sits, how it points to Jesus): quotations that match no excerpt become paraphrase (R2). */
export function dequoteProse(text: string, excerpts: Map<string, ExcerptRow>): string {
  let out = text;
  for (const q of findQuotations(text)) {
    const inner = q.inner.trim();
    if (wordCount(inner) < 2) continue;
    const ok = [...excerpts.values()].some((ex) => ex.match_level !== "working_translation" && matchQuotation(inner, ex.source_text ?? ex.text).level !== "not_found");
    if (!ok) out = dequoteSpan(out, inner);
  }
  return out;
}

/** Picks the default visible set: top priorities, at most one card per author, excluding unavailable sources. */
export function chooseVisible(cards: { priority: number; author_name: string | null; status_source: string; type: string }[], n = 3): Set<number> {
  const order = cards.map((c, i) => ({ c, i })).sort((a, b) => a.c.priority - b.c.priority);
  const out = new Set<number>();
  const authors = new Set<string>();
  for (const { c, i } of order) {
    if (out.size >= n) break;
    if (c.status_source === "unavailable") continue;
    const key = c.author_name ? normalize(c.author_name).text : null;
    if (key && authors.has(key)) continue;
    if (key) authors.add(key);
    out.add(i);
  }
  return out;
}

/** Re-runs verification for stored cards of a run (after a translation change, for example). */
export function loadRunExcerpts(db: DB, runId: string): Map<string, ExcerptRow> {
  const rows = db
    .prepare(
      `SELECT e.id, e.short_id, e.source_id, e.text, e.refs_json, s.kind, s.text AS source_text, s.match_level, s.author_name, s.http_status, s.locator AS source_locator
         FROM excerpts e JOIN sources s ON s.id = e.source_id WHERE e.run_id = ?`,
    )
    .all(runId) as ExcerptRow[];
  return new Map(rows.map((r) => [r.short_id, r]));
}
