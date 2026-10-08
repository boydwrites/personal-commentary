// The study brief: research organized the way the user studies — Scripture first, then the original words, the world
// behind the text, and the voices, each in its own section. Any finding can be highlighted; highlights collect in the notebook.
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Highlighter } from "lucide-react";
import { api } from "../api";
import type { Keep } from "../notes";
import { Menu, useToast } from "./ui";
import { cardStatuses, citationFor } from "./ResearchCard";
import { bookByUsfm } from "../../../shared/refs.ts";
import { useWord, usfmOfRef } from "./WordStudy";

export const SECTION_LABEL: Record<string, string> = {
  where: "Where this sits",
  scripture: "Scripture on Scripture",
  christ: "How it points to Jesus",
  language: "Original words",
  history: "History",
  culture: "Culture",
  commentary: "What the voices say",
  tradition: "Also in the tradition",
};
const SECTION_ORDER = ["where", "scripture", "christ", "language", "history", "culture", "commentary", "tradition"];

export const GROUP_LABEL: Record<string, string> = {
  quoted_or_echoed: "Quoted or echoed",
  same_word_or_image: "Same word or image",
  promise_and_fulfillment: "Promise and fulfillment",
  explains_this_verse: "Explains this verse",
  parallel_account: "Parallel account",
  contrast: "By contrast",
};
const SCRIPTURE_GROUPS = Object.keys(GROUP_LABEL);

export const STRENGTH: Record<string, { label: string; cls: string; title: string }> = {
  fulfilled: { label: "The New Testament says so", cls: "good", title: "A New Testament writer explicitly applies this passage to Jesus." },
  jesus_words: { label: "Jesus’ own words", cls: "good", title: "Jesus himself speaks to this theme." },
  reveals_christ: { label: "Shows who Jesus is", cls: "good", title: "What this passage shows of who Jesus is or what he has done." },
  foreshadows: { label: "Foreshadows", cls: "accent", title: "A pattern or type Christians have long read as pointing to Christ — a Christian reading." },
  thematic: { label: "Thematic thread", cls: "", title: "A real but looser line from this passage to the gospel." },
};

const LEGACY_SECTION: Record<string, string> = { connection: "scripture", commentary: "commentary", history_language: "history", context: "where", another_reading: "tradition", question: "where" };
export const sectionOf = (c: any): string => c.section ?? (c.type === "commentary" && !c.author_name ? "where" : LEGACY_SECTION[c.type] ?? "where");

/** Words in quotation marks stand out in the body; they're the checked words of a source or of Scripture. */
export function Quoted({ text }: { text: string }) {
  const out: React.ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(/“[^”]{2,}”|"[^"]{2,}"/g)) {
    if (m.index! > last) out.push(text.slice(last, m.index));
    out.push(<span key={m.index} className="qt">{m[0]}</span>);
    last = m.index! + m[0].length;
  }
  out.push(text.slice(last));
  return <>{out}</>;
}

/** The brief's items: the latest full research (and anything that finished or deepened it), plus earlier items that stood out. */
export function briefCardsOf(d: any): { current: any[]; earlier: any[]; base: any } {
  const has = (r: any) => d.cards.some((c: any) => c.run_id === r.id);
  const base = [...d.runs].reverse().find((r: any) => r.depth === "standard" && !r.brief?.fill_of && has(r)) ?? d.runs.find(has) ?? null;
  const isCurrent = (c: any) => !base || c.run_id >= base.id;
  return { current: d.cards.filter((c: any) => isCurrent(c) || c.selected), earlier: d.cards.filter((c: any) => !isCurrent(c) && !c.selected), base };
}

export const testamentOf = (d: any): "old" | "new" => ((bookByUsfm(d.study.primary_ref.split(".")[0])?.index ?? 1) >= 40 ? "new" : "old");

/** The words worth quoting from a finding: its checked quotation if it has one, otherwise its title. */
export function keepFromCard(card: any): Keep {
  const quote = card.quotes?.[0];
  if (quote) return { text: quote, cite: card.quote_cites?.[0] ?? card.author_name ?? quoteCite(card) };
  // No checked quotation: the finding is the brief's own words, so it's cited as the brief.
  return { text: card.title, cite: summaryCite(card) };
}
/** Who a checked quotation in a finding belongs to: its voice, or its verses. */
export const quoteCite = (card: any): string => card.author_name ?? ((card.scripture ?? []).map((r: any) => `${r.label} (BSB)`).join("; ") || card.title);
/** The brief's summary of a finding, cited as the brief rather than as the source it describes. */
export const summaryCite = (card: any): string => `Study brief · ${card.author_name ?? ((card.scripture ?? []).map((r: any) => r.label).join(", ") || card.title)}`;
const labelFor = (k: string, testament: string) => (k === "language" ? (testament === "old" ? "The Hebrew" : "The Greek") : SECTION_LABEL[k]);

/** The brief's sections in order, with their labels and item counts. */
export function briefSections(d: any, cards: any[]): { key: string; label: string; count: number | null }[] {
  const runsNewest = [...d.runs].reverse();
  const where = runsNewest.find((r: any) => r.brief?.where)?.brief.where;
  const christSummary = runsNewest.find((r: any) => r.brief?.christ_summary)?.brief.christ_summary;
  const summary = runsNewest.find((r: any) => r.context_summary)?.context_summary;
  const n = (k: string) => cards.filter((c) => sectionOf(c) === k).length;
  return SECTION_ORDER.filter((k) => (k === "where" ? !!(where || summary || n(k)) : k === "christ" ? !!(christSummary || n(k)) : n(k) > 0)).map((k) => ({
    key: k, label: labelFor(k, testamentOf(d)), count: k === "where" ? null : n(k),
  }));
}

const slug = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function loadCollapsed(): string[] {
  try {
    return JSON.parse(localStorage.getItem("commentary.brief.collapsed") ?? "[]");
  } catch {
    return [];
  }
}

export function StudyBrief({
  d, cards, latestRunId, running, onEvidence, onChanged, outline, jumpTo,
}: {
  d: any; cards: any[]; latestRunId: string | null; running: boolean; onEvidence: (id: string) => void; onChanged: () => void;
  /** In the research room: an outline of sections, groups, and voices beside the brief. */
  outline?: boolean;
  /** A section to open at. */
  jumpTo?: string | null;
}) {
  const s = d.study;
  const testament = testamentOf(d);
  const runsNewest = [...d.runs].reverse();
  const where = runsNewest.find((r: any) => r.brief?.where)?.brief.where ?? null;
  const christSummary = runsNewest.find((r: any) => r.brief?.christ_summary)?.brief.christ_summary ?? null;
  const latestBrief = runsNewest.find((r: any) => r.context_summary);
  const latestRun = d.runs.find((r: any) => r.id === latestRunId);
  const isNew = (c: any) => latestRun?.depth === "deeper" && c.run_id === latestRunId;

  const bySection = useMemo(() => {
    const m = new Map<string, any[]>();
    for (const c of cards) {
      const k = sectionOf(c);
      m.set(k, [...(m.get(k) ?? []), c]);
    }
    return m;
  }, [cards]);
  const has = (k: string) => k === "where" ? !!(where || latestBrief?.context_summary || bySection.get("where")?.length) : k === "christ" ? !!(christSummary || bySection.get("christ")?.length) : !!bySection.get(k)?.length;
  const sections = SECTION_ORDER.filter(has);
  const label = (k: string) => labelFor(k, testament);

  const [collapsed, setCollapsed] = useState<string[]>(loadCollapsed);
  const toggle = (k: string) =>
    setCollapsed((cur) => {
      const next = cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k];
      try {
        localStorage.setItem("commentary.brief.collapsed", JSON.stringify(next));
      } catch {
        /* the choice just won't be remembered */
      }
      return next;
    });

  // The section in view is lit in the jump bar.
  const [active, setActive] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Whatever scrolls (the stage's column, the narrow page, the finished page), a captured listener hears it.
    const onScroll = () => {
      // A section is current once its heading passes just below the jump bar (or the top of its scroller).
      const nav = root.current?.querySelector<HTMLElement>(".brief-nav");
      const scroller = root.current?.closest(".stage-main, .stage.narrow") as HTMLElement | null;
      const top = nav && nav.offsetParent ? nav.getBoundingClientRect().bottom : scroller ? scroller.getBoundingClientRect().top : 0;
      const line = top + 40;
      let cur: string | null = sections[0] ?? null;
      for (const k of sections) {
        const el = document.getElementById(`brief-${k}`);
        if (el && el.getBoundingClientRect().top <= line) cur = k;
      }
      setActive(cur);
    };
    onScroll();
    document.addEventListener("scroll", onScroll, { passive: true, capture: true });
    return () => document.removeEventListener("scroll", onScroll, { capture: true });
  }, [sections.join(",")]);
  // Keep the lit chip in view inside the jump bar.
  useEffect(() => {
    root.current?.querySelector<HTMLElement>(".brief-nav button.on")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active]);
  const jump = (k: string, anchor?: string) => {
    if (collapsed.includes(k)) toggle(k);
    setTimeout(() => document.getElementById(anchor ?? `brief-${k}`)?.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
  };
  // Opened at a section from the desk's overview.
  useEffect(() => {
    if (jumpTo) setTimeout(() => jump(jumpTo), 60);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpTo]);

  if (!sections.length) return null;
  const count = (k: string) => (k === "where" ? null : bySection.get(k)?.length ?? 0);

  // Under Scripture its kinds of connection; under the voices their names: the brief's shape at a glance.
  const subs = (k: string): { label: string; anchor: string }[] => {
    const items = bySection.get(k) ?? [];
    if (k === "scripture") return SCRIPTURE_GROUPS.filter((g) => items.some((c) => c.group_label === g)).map((g) => ({ label: GROUP_LABEL[g], anchor: `brief-scripture-${g}` }));
    if (k === "commentary" || k === "tradition") return [...new Set(items.map((c) => c.author_name ?? "Unattributed"))].map((a) => ({ label: a, anchor: `brief-voice-${slug(a)}` }));
    return [];
  };

  return (
    <div className={`study-brief ${outline ? "with-outline" : ""}`} ref={root}>
      {outline && (
        <nav className="brief-outline" aria-label="Brief outline">
          <ol>
            {sections.map((k, i) => (
              <li key={k} className={active === k ? "on" : ""}>
                <button className="ol-sec" onClick={() => jump(k)}>
                  <span className="n">{String(i + 1).padStart(2, "0")}</span>
                  <span className="t">{label(k)}</span>
                  {count(k) ? <span className="c">{count(k)}</span> : null}
                </button>
                {subs(k).length > 0 && (
                  <ul>
                    {subs(k).map((x) => (
                      <li key={x.anchor}>
                        <button onClick={() => jump(k, x.anchor)}>{x.label}</button>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ol>
          {(() => {
            const n = d.cards.filter((c: any) => c.selected).length;
            return n ? <p className="ol-stood"><Highlighter className="lucide" /> {n} highlighted</p> : null;
          })()}
        </nav>
      )}
      <div className="brief-doc">
      {sections.length > 2 && (
        <nav className="brief-nav" aria-label="Brief sections">
          {sections.map((k) => (
            <button key={k} className={active === k ? "on" : ""} onClick={() => jump(k)}>
              {label(k)}
              {count(k) ? <span className="n">{count(k)}</span> : null}
            </button>
          ))}
        </nav>
      )}

      {sections.map((k) => {
        const open = !collapsed.includes(k);
        const items = bySection.get(k) ?? [];
        return (
          <section key={k} id={`brief-${k}`} className={`bsec bsec-${k}`} aria-labelledby={`brief-h-${k}`}>
            <button className="bsec-head" onClick={() => toggle(k)} aria-expanded={open}>
              <span className="bsec-n" aria-hidden="true">{String(sections.indexOf(k) + 1).padStart(2, "0")}</span>
              <h2 id={`brief-h-${k}`}>{label(k)}</h2>
              {count(k) ? <span className="bsec-count">{count(k)}</span> : null}
              <span className="spacer" />
              <ChevronDown className="lucide bsec-chev" />
            </button>
            {open && (
              <div className="bsec-body">
                {k === "where" && <WhereSection where={where} unitLabel={s.unit_label} summary={latestBrief?.context_summary} items={items} onEvidence={onEvidence} onChanged={onChanged} isNew={isNew} />}
                {k === "scripture" && <Grouped idPrefix="brief-scripture-" items={items} order={SCRIPTURE_GROUPS} labels={GROUP_LABEL} fallback="Connected passages" render={(c) => <ScriptureItem key={c.id} card={c} isNew={isNew(c)} onEvidence={onEvidence} onChanged={onChanged} />} />}
                {k === "christ" && (
                  <>
                    {christSummary && <p className="bsec-lede">{christSummary}</p>}
                    <div className="bitems">{items.map((c) => <ChristItem key={c.id} card={c} isNew={isNew(c)} onEvidence={onEvidence} onChanged={onChanged} />)}</div>
                  </>
                )}
                {k === "language" && <div className="bitems">{items.map((c) => <WordItem key={c.id} card={c} isNew={isNew(c)} onEvidence={onEvidence} onChanged={onChanged} />)}</div>}
                {(k === "history" || k === "culture") && <div className="bitems">{items.map((c) => <PlainItem key={c.id} card={c} isNew={isNew(c)} onEvidence={onEvidence} onChanged={onChanged} />)}</div>}
                {(k === "commentary" || k === "tradition") && (
                  <Voices items={items} gaps={k === "commentary" ? latestBrief?.gaps ?? [] : []} isNew={isNew} onEvidence={onEvidence} onChanged={onChanged} />
                )}
              </div>
            )}
          </section>
        );
      })}

      {latestBrief && !running && latestBrief.qualification && (
        <section className="bsec bsec-writing" aria-label="Keep in mind">
          <div className="caution">
            <span className="caution-h">Keep in mind</span>
            {latestBrief.qualification}
          </div>
        </section>
      )}
      </div>
    </div>
  );
}

// ---------------- Sections ----------------

function WhereSection({ where, unitLabel, summary, items, onEvidence, onChanged, isNew }: { where: any; unitLabel: string | null; summary?: string; items: any[]; onEvidence: (id: string) => void; onChanged: () => void; isNew: (c: any) => boolean }) {
  const rows: [string, string][] = where
    ? ([["The book", where.book], ["This section", where.section], ["The flow", where.flow], ["This verse", where.this_verse]] as [string, string][]).filter(([, v]) => v)
    : [];
  return (
    <>
      {unitLabel && <p className="unit-label">{unitLabel}</p>}
      {rows.length ? (
        <dl className="where">
          {rows.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd><Quoted text={v} /></dd>
            </div>
          ))}
        </dl>
      ) : (
        summary && <p className="bsec-lede">{summary}</p>
      )}
      {items.length > 0 && <div className="bitems">{items.map((c) => <PlainItem key={c.id} card={c} isNew={isNew(c)} onEvidence={onEvidence} onChanged={onChanged} />)}</div>}
    </>
  );
}

function Grouped({ items, order, labels, fallback, render, idPrefix }: { items: any[]; order: string[]; labels: Record<string, string>; fallback: string; render: (c: any) => React.ReactNode; idPrefix: string }) {
  const groups = new Map<string, any[]>();
  for (const c of items) {
    const g = c.group_label && labels[c.group_label] ? c.group_label : "_other";
    groups.set(g, [...(groups.get(g) ?? []), c]);
  }
  const keys = [...order.filter((g) => groups.has(g)), ...(groups.has("_other") ? ["_other"] : [])];
  return (
    <>
      {keys.map((g) => (
        <div key={g} className="bgroup" id={`${idPrefix}${g}`}>
          {keys.length > 1 || g !== "_other" ? <h3 className="bgroup-head">{g === "_other" ? fallback : labels[g]}</h3> : null}
          <div className="bitems">{groups.get(g)!.map(render)}</div>
        </div>
      ))}
    </>
  );
}

function Voices({ items, gaps, isNew, onEvidence, onChanged }: { items: any[]; gaps: any[]; isNew: (c: any) => boolean; onEvidence: (id: string) => void; onChanged: () => void }) {
  // One block per voice, in the order the brief ranked them.
  const byAuthor = new Map<string, any[]>();
  for (const c of items) {
    const a = c.author_name ?? "Unattributed";
    byAuthor.set(a, [...(byAuthor.get(a) ?? []), c]);
  }
  // Jewish commentary was retired from research (Oct 3, 2026); older briefs don't list it as missing.
  const shownGaps = gaps.filter((g: any) => !/Jewish commentary|Rashi|Ibn Ezra|Ramban|Nachmanides|Sforno/.test(g.author_name) && !byAuthor.has(g.author_name));
  return (
    <>
      {[...byAuthor].map(([author, cs]) => {
        const work = workOf(cs[0]);
        return (
          <div key={author} className="voice-block" id={`brief-voice-${slug(author)}`}>
            <div className="voice-who">
              <span className="voice-name">{author}</span>
              {work && <span className="voice-work">{work}</span>}
            </div>
            <div className="bitems">{cs.map((c) => <VoiceItem key={c.id} card={c} isNew={isNew(c)} onEvidence={onEvidence} onChanged={onChanged} />)}</div>
          </div>
        );
      })}
      {shownGaps.length > 0 && (
        <ul className="voice-gaps" aria-label="Voices with nothing on this passage">
          {shownGaps.map((g: any, i: number) => (
            <li key={i}><span>{g.author_name}</span> {g.note}</li>
          ))}
        </ul>
      )}
    </>
  );
}

function workOf(c: any): string | null {
  const w = c.sources?.filter((s: any) => s.kind !== "bible_text" && s.kind !== "cross_reference").map((s: any) => s.work || s.locator).filter(Boolean)[0];
  if (!w || !c.author_name) return w ?? null;
  const same = w.toLowerCase().includes(c.author_name.toLowerCase()) || c.author_name.toLowerCase().includes(w.toLowerCase().replace(/^(the )/, ""));
  return same ? null : w;
}

// ---------------- Items ----------------

function ScriptureItem({ card, isNew, onEvidence, onChanged }: ItemProps) {
  const [open, setOpen] = useState(false);
  const refs: { label: string; text: string }[] = card.scripture ?? [];
  const labels = refs.length ? refs.map((r) => r.label) : card.data?.refs ?? [];
  return (
    <BriefItem card={card} isNew={isNew} onEvidence={onEvidence} onChanged={onChanged} kicker={labels.length ? <span className="ref-kicker">{labels.join(" · ")}</span> : null}>
      <p className="bi-body"><Quoted text={card.body} /></p>
      {refs.length > 0 && (
        <>
          <button className="text-btn row read-verse" onClick={() => setOpen((x) => !x)} aria-expanded={open}>
            {open ? "Hide" : "Read"} {refs.map((r) => r.label).join(", ")}
            <ChevronDown className="lucide" style={{ width: 14, height: 14, transform: open ? "rotate(180deg)" : undefined }} />
          </button>
          {open && (
            <div className="verse-text rise">
              {refs.map((r) => (
                <p key={r.label}><Verses text={r.text} /></p>
              ))}
            </div>
          )}
        </>
      )}
    </BriefItem>
  );
}

function ChristItem({ card, isNew, onEvidence, onChanged }: ItemProps) {
  const st = STRENGTH[card.group_label] ?? null;
  const refs = (card.scripture ?? []).map((r: any) => r.label);
  return (
    <BriefItem card={card} isNew={isNew} onEvidence={onEvidence} onChanged={onChanged}
      kicker={<>{st && <span className={`pill strength ${st.cls}`} title={st.title}>{st.label}</span>}{refs.length ? <span className="ref-kicker">{refs.join(" · ")}</span> : null}{card.author_name ? <span className="ref-kicker">{card.author_name}</span> : null}</>}>
      <p className="bi-body"><Quoted text={card.body} /></p>
    </BriefItem>
  );
}

function WordItem({ card, isNew, onEvidence, onChanged }: ItemProps) {
  const w = card.data ?? {};
  const study = useWord(w.strong ?? null, usfmOfRef(w.in_verse?.ref));
  const key = study.data?.key ?? (w.uses ?? []).map((u: any) => ({ ref: u.ref, text: u.text }));
  return (
    <BriefItem card={card} isNew={isNew} onEvidence={onEvidence} onChanged={onChanged}
      head={
        w.lemma ? (
          <div className="word-head">
            <span className="orig" lang={w.language === "he" ? "he" : "grc"} dir={w.language === "he" ? "rtl" : "ltr"}>{w.lemma}</span>
            <span className="translit">{w.translit}</span>
            {w.in_verse?.gloss && <span className="gloss">rendered <b>{w.in_verse.gloss.replace(/[,.;:·?]+$/, "").trim()}</b> here</span>}
            <span className="strong" title="Strong's number">{w.strong}</span>
          </div>
        ) : null
      }>
      <p className="bi-body"><Quoted text={card.body} /></p>
      {w.strong && (
        <div className="wi-uses">
          {key.length > 0 && (
            <span className="wi-also">
              <span className="wi-label">Also in</span>
              {key.slice(0, 4).map((u: any) => <span key={u.ref} className="wi-ref" title={u.text}>{u.ref}</span>)}
            </span>
          )}
          <button className="text-btn row wi-open" onClick={() => onEvidence(card.id)}>
            Word study{study.data ? ` · ${study.data.count} uses` : ""} <ChevronDown className="lucide" style={{ width: 14, height: 14, transform: "rotate(-90deg)" }} />
          </button>
        </div>
      )}
    </BriefItem>
  );
}

function PlainItem({ card, isNew, onEvidence, onChanged }: ItemProps) {
  const src = card.sources?.find((x: any) => x.kind !== "bible_text" && x.kind !== "cross_reference");
  const general = !card.sources?.length;
  return (
    <BriefItem card={card} isNew={isNew} onEvidence={onEvidence} onChanged={onChanged}
      kicker={general ? <span className="pill" title="Widely known background that no gathered source states">General background</span> : src ? <span className="ref-kicker">{[card.author_name ?? src.author_name, src.work].filter(Boolean).filter((x, i, a) => a.indexOf(x) === i).join(" · ")}</span> : null}>
      <p className="bi-body"><Quoted text={card.body} /></p>
    </BriefItem>
  );
}

function VoiceItem({ card, isNew, onEvidence, onChanged }: ItemProps) {
  return (
    <BriefItem card={card} isNew={isNew} onEvidence={onEvidence} onChanged={onChanged}>
      <p className="bi-body voice-body"><Quoted text={card.body} /></p>
    </BriefItem>
  );
}

/** "[10:5] text [10:6] text" → verse numbers as superscripts. */
export function Verses({ text }: { text: string }) {
  const parts = text.split(/\[(\d+:\d+)\]\s?/);
  if (parts.length === 1) return <>{text}</>;
  return <>{parts.map((p, i) => (i % 2 ? <sup key={i}>{p.split(":")[1]}</sup> : <span key={i}>{p}</span>))}</>;
}

// ---------------- The shell every item shares ----------------

type ItemProps = { card: any; isNew: boolean; onEvidence: (id: string) => void; onChanged: () => void };

export const NOISY_FLAG = /^Body is \d+ words|^Quote matched; punctuation differs|^Quote matched with an ellipsis/;

function BriefItem({ card, isNew, onEvidence, onChanged, kicker, head, children }: ItemProps & { kicker?: React.ReactNode; head?: React.ReactNode; children: React.ReactNode }) {
  const toast = useToast();
  const [disputing, setDisputing] = useState(false);
  const [reason, setReason] = useState("");
  const disputed = card.status_interpretation === "disputed";
  const patch = async (body: any) => {
    try {
      await api(`/api/cards/${card.id}`, { method: "PATCH", body });
      onChanged();
    } catch (e: any) {
      toast(e.message, "error");
    }
  };
  const saveLater = async () => {
    try {
      await api("/api/later", { method: "POST", body: { kind: "card", card_id: card.id, study_id: card.study_id } });
      toast("Saved for later. Find it in the Library under Saved for later.");
    } catch (e: any) {
      toast(e.message, "error");
    }
  };
  // Only the states worth noticing show here; all three stay in the evidence drawer (R3).
  const statuses = cardStatuses(card).filter((st) => st.cls === "bad" || st.text === "Interpretation reviewed" || st.text === "Paraphrase of a translation");
  const flags = (card.flags ?? []).filter((f: string) => !NOISY_FLAG.test(f) && !(card.status_quote === "dequoted" && /changed to paraphrase/i.test(f)));

  return (
    <article
      className={`bitem ${card.selected ? "highlighted" : ""} ${disputed ? "disputed" : ""}`}
      aria-label={card.title}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("button, a, input, form, .verse-text, .lexicon")) return;
        // Selecting words to highlight isn't a click to open.
        if (!window.getSelection()?.isCollapsed) return;
        onEvidence(card.id);
      }}
    >
      <div className="bi-top">
        {kicker || isNew || head ? (
          <div className="bi-kicker">
            {isNew && <span className="pill accent">New</span>}
            {kicker}
          </div>
        ) : (
          <h3 className="bi-title inline">{card.title}</h3>
        )}
        <HighlightToggle on={card.selected} disabled={disputed} onToggle={() => patch({ selected: !card.selected })} />
        <Menu
          label={`More for “${card.title}”`}
          items={[
            { label: "Open sources", onSelect: () => onEvidence(card.id) },
            { label: "Save for later", onSelect: saveLater },
            {
              label: "Copy citation",
              onSelect: () => {
                navigator.clipboard.writeText(citationFor(card));
                toast("Citation copied.");
              },
            },
            "divider",
            disputed ? { label: "Clear dispute", onSelect: () => patch({ status_interpretation: "unreviewed" }) } : { label: "Report a problem…", onSelect: () => setDisputing(true) },
          ]}
        />
      </div>
      {head}
      {(kicker || isNew || head) && <h3 className="bi-title">{card.title}</h3>}
      <div data-keep={quoteCite(card)} data-keep-summary={summaryCite(card)} data-card={card.id}>{children}</div>
      {(statuses.length > 0 || card.limitation || card.disagreement || flags.length > 0) && (
        <div className="bi-foot">
          {statuses.map((st) => (
            <span key={st.text} className={`status ${st.cls}`} title={st.text === "Changed to paraphrase" ? "The quoted wording wasn't found in the source, so it's shown as a paraphrase." : undefined}>
              {st.icon}
              {st.text}
            </span>
          ))}
          {card.limitation && <div className="card-note">{card.limitation}</div>}
          {card.disagreement && <div className="card-note">Disagreement: {card.disagreement}</div>}
          {flags.map((f: string, i: number) => <div key={i} className="card-note warn">{f}</div>)}
        </div>
      )}
      {disputed && card.dispute_reason && <div className="card-note" style={{ color: "var(--bad)" }}>You disputed this: {card.dispute_reason}</div>}
      {disputing && (
        <form
          className="dispute-form"
          onSubmit={(e) => {
            e.preventDefault();
            patch({ status_interpretation: "disputed", dispute_reason: reason, ...(card.selected ? { selected: false } : {}) });
            setDisputing(false);
          }}
        >
          <input className="input" autoFocus placeholder="What's wrong with it?" value={reason} onChange={(e) => setReason(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setDisputing(false)} />
          <button className="btn secondary sm" type="submit" disabled={!reason.trim()}>Dispute</button>
        </form>
      )}
    </article>
  );
}

/** The one gesture for "this caught me": the finding joins your notebook's highlights, and a first draft leads with it. */
export function HighlightToggle({ on, disabled, onToggle, size = "sm" }: { on: boolean; disabled?: boolean; onToggle: () => void; size?: "sm" | "md" }) {
  return (
    <button
      className={`hl-toggle ${size} ${on ? "on" : ""}`}
      aria-label="Highlight"
      aria-pressed={on}
      disabled={disabled}
      onClick={onToggle}
      title={disabled ? "Disputed findings can't be highlighted" : on ? "In your notebook. Click to remove the highlight." : "Add to your notebook's highlights. A first draft leads with what you highlight."}
    >
      <Highlighter className="lucide" />
      <span>{on ? "Highlighted" : "Highlight"}</span>
    </button>
  );
}
