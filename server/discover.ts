// Stage D: web search, limited to the sites of the user's preferred preachers, for their written comment on a passage.
// The model only proposes URLs. Each page is fetched through fetcher.ts and kept only if its own text cites the passage.
import type { DB } from "./db.ts";
import { fetchText } from "./fetcher.ts";
import { callStructured } from "./llm.ts";
import { discoverPrompt, DISCOVER_SCHEMA, researchSystemPrompt, VERSIONS, type DiscoverOutput } from "./prompts.ts";
import { articleText, mentionsPassage } from "./sources/voices.ts";
import { log } from "./log.ts";

type Range = { book: string; c1: number; v1: number; c2: number; v2: number };
export interface WebVoice { id: string; name: string; sites: string[] }
export interface FoundPage { authorId: string; url: string; title: string; text: string; status: number }

/** A page with less text than this is a player or an index, not a sermon or article. */
const MIN_WORDS = 150;

export async function discoverVoices(db: DB, a: { range: Range; displayRef: string; verseText: string; voices: WebVoice[]; studyId: string; runId: string; signal?: AbortSignal }): Promise<{ found: FoundPage[]; proposed: number }> {
  if (!a.voices.length) return { found: [], proposed: 0 };
  const sites = [...new Set(a.voices.flatMap((v) => v.sites))];
  const res = await callStructured<DiscoverOutput>({
    db, stage: "discover", promptVersion: VERSIONS.discover, system: researchSystemPrompt(),
    user: discoverPrompt({ displayRef: a.displayRef, verseText: a.verseText.slice(0, 400), voices: a.voices }),
    schema: DISCOVER_SCHEMA, effort: "low", maxTokens: 4000, webSearchDomains: sites, maxSearches: 4,
    studyId: a.studyId, runId: a.runId, signal: a.signal,
  });
  const known = new Map(a.voices.map((v) => [v.id, v]));
  const seen = new Set<string>();
  const pages = res.data.pages.filter((p) => {
    const v = known.get(p.author_id);
    let host = "";
    try { host = new URL(p.url).hostname.replace(/^www\./, ""); } catch { return false; }
    if (!v || !v.sites.some((s) => host === s || host.endsWith("." + s)) || seen.has(p.url)) return false;
    seen.add(p.url);
    return true;
  }).slice(0, 6);
  const fetched = await Promise.allSettled(pages.map(async (p) => {
    const page = await fetchText(p.url, { page: true, cacheDays: 30, signal: a.signal });
    const art = articleText(page.body);
    const words = art.text.split(/\s+/).length;
    if (words < MIN_WORDS || !mentionsPassage(art.text, a.range)) {
      log("info", "discover", "page_rejected", { url: p.url, words, cites: mentionsPassage(art.text, a.range) });
      return null;
    }
    return { authorId: p.author_id, url: page.finalUrl || p.url, title: art.title || p.title, text: art.text, status: page.status } as FoundPage;
  }));
  const found = fetched.flatMap((f) => (f.status === "fulfilled" && f.value ? [f.value] : []));
  return { found, proposed: pages.length };
}
