// An item, opened: the reading itself (with its Scripture or word study), then every source it rests on, once each,
// with the checked words lit in the source's own text. Reviewing an interpretation happens here (R3).
import { useEffect, useReducer, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronDown, Copy, ExternalLink, Languages, Quote, X } from "lucide-react";
import { api, queryClient, whenPhrase } from "../api";
import { Drawer, Link, useToast, Dots } from "./ui";
import { cardStatuses, citationFor } from "./ResearchCard";
import { GROUP_LABEL, HighlightToggle, NOISY_FLAG, Quoted, SECTION_LABEL, STRENGTH, Verses, keepFromCard, quoteCite, sectionOf, summaryCite } from "./Brief";
import { addToNote, type Keep } from "../notes";
import { WordStudy, usfmOfRef } from "./WordStudy";

const RIGHTS: Record<string, string> = { public_domain: "Public domain", cc_by: "CC BY", fair_use_excerpt: "Excerpt", link_only: "Link only", unknown: "Rights unknown" };

type Span = { start: number; end: number };

// Working translations outlive the drawer: closing it while one is on its way, or reopening the item later, keeps the result.
const translations = new Map<string, { status: "working" } | { status: "done"; result: any } | { status: "failed"; message: string }>();
const translationListeners = new Set<() => void>();
const translationKey = (e: any) => `${e.source.id}:${e.excerpt.start}-${e.excerpt.end}`;
function requestTranslation(e: any, studyId: string) {
  const key = translationKey(e);
  if (translations.get(key)?.status === "working") return;
  translations.set(key, { status: "working" });
  translationListeners.forEach((f) => f());
  api(`/api/sources/${e.source.id}/working-translation`, { method: "POST", body: { text: e.window.text.slice(Math.max(0, e.excerpt.start), e.excerpt.end).slice(0, 5000), studyId } })
    .then((result) => translations.set(key, { status: "done", result }))
    .catch((err: Error) => translations.set(key, { status: "failed", message: err.message }))
    .finally(() => translationListeners.forEach((f) => f()));
}
function useTranslations() {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    translationListeners.add(bump);
    return () => void translationListeners.delete(bump);
  }, []);
}

/** The source's text with every matched quotation lit; with none, the excerpt the item drew on is marked at its edge. */
function Highlighted({ text, matches, excerpts }: { text: string; matches: Span[]; excerpts: Span[] }) {
  const ok = (x: Span) => x.start >= 0 && x.end <= text.length && x.end > x.start;
  const spans = (matches.filter(ok).length ? matches.filter(ok) : excerpts.filter(ok)).sort((a, b) => a.start - b.start);
  const cls = matches.filter(ok).length ? "match" : "excerpt";
  const out: React.ReactNode[] = [];
  let at = 0;
  for (const sp of spans) {
    const st = Math.max(sp.start, at);
    if (st >= sp.end) continue;
    out.push(text.slice(at, st));
    out.push(<mark key={st} className={cls}>{text.slice(st, sp.end)}</mark>);
    at = sp.end;
  }
  out.push(text.slice(at));
  return <>{out}</>;
}

export function EvidenceDrawer({ cardId, d, onClose, onChanged }: { cardId: string | null; d: any; onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const q = useQuery({ queryKey: ["evidence", cardId], queryFn: () => api(`/api/cards/${cardId}/evidence`), enabled: !!cardId });
  useTranslations();
  const ev = q.data;
  // The study's copy of the item carries its Scripture text, word data, and quotations; the evidence call carries the sources.
  const card = d.cards.find((c: any) => c.id === cardId) ?? (ev ? { ...ev.card, selected: !!ev.card.selected, data: JSON.parse(ev.card.data_json ?? "{}") } : null);

  const patch = async (body: any) => {
    try {
      await api(`/api/cards/${cardId}`, { method: "PATCH", body });
      onChanged();
      queryClient.invalidateQueries({ queryKey: ["evidence", cardId] });
    } catch (e: any) {
      toast(e.message, "error");
    }
  };
  const keep = async (k: Keep) => {
    try {
      const how = await addToNote(d.study.id, k);
      toast(how === "saved" ? "Quoted in your notes." : "Quoted in your notes, at your cursor.");
    } catch (e: any) {
      toast(e.message, "error");
    }
  };
  const status = ev?.card.status_interpretation ?? card?.status_interpretation;
  const reviewed = status === "reviewed";
  const disputed = status === "disputed";
  const section = card ? sectionOf(card) : null;
  const strength = card && section === "christ" ? STRENGTH[card.group_label] : null;
  const group = card && section === "scripture" ? GROUP_LABEL[card.group_label] : null;
  const refs: { label: string; text: string }[] = card?.scripture ?? [];
  const w = card?.data ?? {};
  const rtl = w.language === "he";
  const flags: string[] = (card?.flags ?? []).filter((f: string) => !NOISY_FLAG.test(f) && !(card.status_quote === "dequoted" && /changed to paraphrase/i.test(f)));

  return (
    <Drawer open={!!cardId} onClose={onClose} label={card?.title ?? "Research item"}>
      <div className="drawer-head">
        <div className="row">
          <div className="grow">
            <div className="drawer-kicker">
              <span className="label">{section ? (section === "language" ? (rtl ? "The Hebrew" : "The Greek") : SECTION_LABEL[section]) : "Research"}</span>
              {group && <span className="ref-kicker">{group}</span>}
              {strength && <span className={`pill strength ${strength.cls}`} title={strength.title}>{strength.label}</span>}
            </div>
            <h2 className="drawer-title">{card?.title ?? " "}</h2>
            {(card?.author_name || refs.length > 0) && (
              <div className="drawer-who">{card.author_name ?? refs.map((r) => r.label).join(" · ")}</div>
            )}
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <X className="lucide" />
          </button>
        </div>
        {card && (
          <div className="drawer-actions">
            <HighlightToggle size="md" on={card.selected} disabled={disputed} onToggle={() => patch({ selected: !card.selected })} />
            <button className="btn sm ghost" onClick={() => keep(keepFromCard(card))} title="Quote its words in your notes" data-autofocus>
              <Quote className="lucide" /> Quote in your notes
            </button>
            {!disputed && (
              <button className={`btn sm ${reviewed ? "ghost good-text" : "secondary"}`} onClick={() => patch({ status_interpretation: reviewed ? "unreviewed" : "reviewed" })} title="Only you can mark an interpretation reviewed">
                {reviewed ? <><Check className="lucide" /> Reading checked</> : "I've checked this reading"}
              </button>
            )}
            <span className="spacer" />
            <button
              className="icon-btn"
              title="Copy citation"
              aria-label="Copy citation"
              onClick={() => {
                navigator.clipboard.writeText(citationFor(card));
                toast("Citation copied.");
              }}
            >
              <Copy className="lucide" />
            </button>
          </div>
        )}
      </div>

      <div className="drawer-body">
        {card && (
          <article className="reading">
            {w.lemma && (
              <div className="word-head big">
                <span className="orig" lang={rtl ? "he" : "grc"} dir={rtl ? "rtl" : "ltr"}>{w.lemma}</span>
                <span className="translit">{w.translit}</span>
                {w.in_verse?.gloss && <span className="gloss">“{w.in_verse.gloss.trim()}” here</span>}
                <span className="strong" title="Strong's number">{w.strong}</span>
              </div>
            )}
            <p className="reading-body" data-keep={quoteCite(card)} data-keep-summary={summaryCite(card)}>
              <Quoted text={card.body} />
            </p>
            <div className="reading-status">
              {cardStatuses(card).map((st) => (
                <span key={st.text} className={`status ${st.cls}`}>
                  {st.icon}
                  {st.text}
                </span>
              ))}
            </div>
            {refs.length > 0 && (
              <div className="reading-scripture" data-keep="">
                {refs.map((r) => (
                  <blockquote key={r.label} data-keep={`${r.label} (BSB)`}>
                    <Verses text={r.text} />
                    <footer>{r.label}</footer>
                  </blockquote>
                ))}
              </div>
            )}
            {w.strong && <WordStudy strong={w.strong} at={usfmOfRef(w.in_verse?.ref) ?? d.study.primary_ref} showHead={false} />}
            {(card.limitation || card.disagreement || flags.length > 0 || (disputed && card.dispute_reason)) && (
              <div className="reading-notes">
                {card.limitation && <p>{card.limitation}</p>}
                {card.disagreement && <p>Disagreement: {card.disagreement}</p>}
                {flags.map((f, i) => <p key={i} className="warn">{f}</p>)}
                {disputed && card.dispute_reason && <p className="bad">You disputed this: {card.dispute_reason}</p>}
              </div>
            )}
          </article>
        )}

        {q.isLoading && <Dots label="Loading sources" />}
        {ev && (
          <section className="sources">
            <h3 className="label">{ev.evidence.length === 0 ? "Sources" : ev.evidence.length === 1 ? "The source" : `${ev.evidence.length} sources`}</h3>
            {ev.evidence.length === 0 && <p className="muted small">This item draws on the passage itself and general background. There's no outside source to show.</p>}
            {ev.evidence.map((e: any) => (
              <SourceEntry key={e.id} e={e} studyId={d.study.id} onClose={onClose} onKeep={keep}
                translation={translations.get(translationKey(e))}
                onTranslate={() => requestTranslation(e, d.study.id)}
                // The item's own word study is open above; its lexicon entry needn't repeat it.
                wordShownAbove={!!w.strong && e.source.word?.strong === w.strong}
              />
            ))}
          </section>
        )}
      </div>
    </Drawer>
  );
}

function SourceEntry({ e, onClose, translation, onTranslate, onKeep, wordShownAbove }: { e: any; studyId: string; onClose: () => void; translation: ReturnType<typeof translations.get>; onTranslate: () => void; onKeep: (k: Keep) => void; wordShownAbove: boolean }) {
  const toast = useToast();
  const box = useRef<HTMLDivElement>(null);
  const helper = useRef<HTMLDivElement>(null);
  const word = e.source.word as { strong: string; at: string } | null;
  // A lexicon entry reads as a word study; its raw text is a click away, for checking.
  const [rawOpen, setRawOpen] = useState(!word);
  useEffect(() => {
    if (translation?.status === "done") helper.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [translation?.status]);
  // Center the lit words inside the source's own scroll box.
  useEffect(() => {
    const el = box.current;
    const m = el?.querySelector("mark") as HTMLElement | null;
    if (el && m) el.scrollTop = Math.max(0, m.offsetTop - el.clientHeight / 3);
  }, [e.id, rawOpen]);
  const who = e.source.fullIdentity ?? e.source.author ?? e.source.title;
  const matched = (e.quotes ?? []).filter((x: any) => x.match && x.match !== "not_found");
  const missed = (e.quotes ?? []).filter((x: any) => x.match === "not_found");
  return (
    <div className="evidence">
      <div>
        <div className="evidence-who">{who}</div>
        <div className="small muted">{[...new Set([e.source.work, e.source.locator, e.source.edition].filter(Boolean))].join(" · ")}</div>
        <div className="row wrap" style={{ marginTop: 8, gap: 6 }}>
          <span className={`pill ${e.source.rights === "public_domain" ? "good" : e.source.rights === "link_only" ? "warn" : ""}`}>{RIGHTS[e.source.rights] ?? e.source.rights}</span>
          {matched.length > 0 && (
            <span className="pill good">
              <Check className="lucide" /> {matched.length > 1 ? `${matched.length} quotes matched` : "Quote matched"}
            </span>
          )}
          {missed.length > 0 && <span className="pill warn">Quote not found in source</span>}
          {e.source.url && (
            <a className="text-btn accent row" style={{ gap: 4, marginLeft: 4 }} href={e.source.url} target="_blank" rel="noreferrer noopener">
              Original <ExternalLink className="lucide" />
            </a>
          )}
        </div>
        {e.source.careNote && <div className="card-note warn">{e.source.careNote}</div>}
      </div>
      {e.nearMatch && e.quote && (
        <div className="small">
          <span className="muted">The item quoted </span>“{e.quote}”<span className="muted"> — the source reads </span>“{e.nearMatch}”
        </div>
      )}
      {word && !wordShownAbove && <div className="source-word"><WordStudy strong={word.strong} at={word.at} compact /></div>}
      {word && (
        <button className="text-btn row" onClick={() => setRawOpen((x) => !x)} aria-expanded={rawOpen}>
          {rawOpen ? "Hide the source text" : "Show the source text"}
          <ChevronDown className="lucide" style={{ width: 14, height: 14, transform: rawOpen ? "rotate(180deg)" : undefined }} />
        </button>
      )}
      {rawOpen && (
        <div className="source-text" ref={box} data-keep={e.source.author ?? e.source.title}>
          {e.window.truncatedStart && "… "}
          <Highlighted text={e.window.text} matches={e.matchSpans ?? (e.matchSpan ? [e.matchSpan] : [])} excerpts={e.excerpts ?? [e.excerpt]} />
          {e.window.truncatedEnd && " …"}
        </div>
      )}
      <div className="row wrap" style={{ gap: 16 }}>
        {matched.map((x: any) => (
          <span key={x.text} className="row" style={{ gap: 14 }}>
            <button
              className="text-btn row"
              onClick={() => {
                navigator.clipboard.writeText(`${e.source.title}: “${x.text}”`);
                toast("Quote copied with its citation.");
              }}
            >
              <Copy className="lucide" /> Copy quote
            </button>
            <button className="text-btn row" onClick={() => onKeep({ text: x.text, cite: e.source.author ?? e.source.title })}>
              <Quote className="lucide" /> Quote in your notes
            </button>
          </span>
        ))}
        {/* A lexicon entry is already in English; translating it would only restate it. */}
        {e.source.language !== "en" && e.source.kind !== "lexicon_entry" && (!translation || translation.status === "failed") && (
          <button className="text-btn row" onClick={onTranslate}>
            <Languages className="lucide" /> {translation?.status === "failed" ? "Try translating again" : "Translate for me"}
          </button>
        )}
        {e.source.fetchedAt && <span className="tiny faint" style={{ marginLeft: "auto" }}>Kept {whenPhrase(e.source.fetchedAt)}</span>}
      </div>
      {translation?.status === "working" && (
        <div className="helper" role="status">
          <div className="label">Working translation</div>
          <p className="small muted" style={{ margin: "8px 0 0" }}><Dots label="Translating" /> Translating the excerpt. This takes about ten seconds; you can close this and come back.</p>
        </div>
      )}
      {translation?.status === "failed" && <p className="small bad">The translation didn't come back: {translation.message} The source text above is unchanged.</p>}
      {translation?.status === "done" && (
        <div className="helper rise" ref={helper}>
          <div className="label">Working translation · for understanding, not for quoting</div>
          <p className="serif" style={{ margin: "8px 0 0", whiteSpace: "pre-wrap" }}>{translation.result.translation}</p>
          {translation.result.uncertain_words?.length > 0 && <div className="small muted" style={{ marginTop: 6 }}>Uncertain: {translation.result.uncertain_words.join(", ")}</div>}
        </div>
      )}
      {e.usedElsewhere?.length > 0 && (
        <div className="small muted">
          You've used this before in{" "}
          {e.usedElsewhere.map((s: any, i: number) => (
            <span key={s.id}>
              {i > 0 && ", "}
              <Link to={`/study/${s.id}`} className="link" onClick={onClose}>{s.display_ref}</Link>
            </span>
          ))}
          .
        </div>
      )}
    </div>
  );
}
