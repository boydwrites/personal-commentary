// Research: the study brief as one document, Scripture first, with the notebook beside it.
// Research runs once per passage and is kept; an older brief can be refreshed through an explicit, potentially paid action.
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { BookOpen, Check, ChevronDown, X as XIcon } from "lucide-react";
import { api, fmtDate, navigate } from "../api";
import { useToast, Dots } from "../components/ui";
import { StudyBrief, briefCardsOf, testamentOf } from "../components/Brief";
import { Passage } from "../components/Passage";
import { flushPendingChanges } from "../desktop";
import { HeaderAction, usePrimaryShortcut } from "./StudyHeader";

export function useResearch(d: any, refresh: () => void) {
  const toast = useToast();
  const run = d.runs.at(-1);
  const running = !!run && (run.status === "queued" || run.status === "running");
  const { current, earlier, base } = briefCardsOf(d);
  const start = async (depth: "standard" | "deeper" | "fill") => {
    try {
      if (!(await flushPendingChanges())) return false;
      const r = await api(`/api/studies/${d.study.id}/research`, { method: "POST", body: { depth } });
      if (r.reused) toast(`Your research from ${r.reused.displayRef} (${fmtDate(r.reused.date)}) is here. Nothing new was spent.`);
      refresh();
      return true;
    } catch (e: any) {
      toast(e.message, "error");
      refresh();
      return false;
    }
  };
  const cancel = async () => {
    await api(`/api/runs/${run.id}/cancel`, { method: "POST" });
    refresh();
  };
  return { run, running, current, earlier, base, start, cancel, anyCards: d.cards.length > 0 };
}

/** Where this brief came from: when it was researched, or which study it was kept from. */
export function Provenance({ d, base }: { d: any; base: any }) {
  if (!base) return null;
  const from = base.brief?.reused_from;
  const deeper = d.runs.some((r: any) => r.depth === "deeper" && ["succeeded", "partial"].includes(r.status));
  const sources = d.runs.filter((r: any) => r.id >= base.id).reduce((n: number, r: any) => n + (r.sourceCount ?? 0), 0);
  return (
    <p className="provenance">
      <Check className="lucide" />
      {from ? (
        <span>Kept from your study of {from.display_ref}, {fmtDate(from.date)} · nothing new spent</span>
      ) : (
        <span>Researched {fmtDate(base.finished_at ?? base.queued_at)}{sources ? ` · ${sources} sources` : ""}{deeper ? " · deepened" : ""}</span>
      )}
    </p>
  );
}

export function ResearchProgress({ d, run, onCancel }: { d: any; run: any; onCancel: () => void }) {
  const stageList = d.stages.map((st: any) => ({ ...st, ...(run?.stages[st.key] ?? { status: "queued" }) }));
  const doneCount = stageList.filter((x: any) => ["done", "skipped", "failed"].includes(x.status)).length;
  const current = stageList.find((x: any) => x.status === "running");
  return (
    <section className="rs-progress rise" aria-label="Research progress">
      <div className="rs-progress-head">
        <h2>{run.brief?.fill_of ? "Finishing the brief" : run.depth === "deeper" ? "Going deeper" : "Researching"}<Dots /></h2>
        <button className="btn sm ghost" onClick={onCancel}>Cancel</button>
      </div>
      <p className="rs-progress-note">About a minute.</p>
      <div className="progress-bar" aria-hidden="true">
        <span style={{ width: `${Math.max(6, (doneCount / stageList.length) * 100)}%` }} />
      </div>
      <ul className="progress-list">
        {stageList.map((x: any) => (
          <li key={x.key} className={x.status}>
            <span className="p-icon" aria-hidden="true">
              {x.status === "running" ? <span className="spin" /> : x.status === "done" ? <Check className="lucide p-done" /> : x.status === "failed" ? <XIcon className="lucide" /> : x.status === "skipped" ? <span className="faint">–</span> : <span className="p-ring" />}
            </span>
            <span>{x.label}</span>
            {(x.detail || x.error) && <span className="p-detail">{x.error ?? x.detail}</span>}
          </li>
        ))}
      </ul>
      <div className="sr-only" aria-live="polite">{current ? `Researching: ${current.label}` : "Starting research"}</div>
    </section>
  );
}

const MISSING_LABEL: Record<string, string> = { SA: "Scripture and Jesus", SB: "words, history, and culture", SC: "the voices" };

export function ResearchStage({ d, refresh, onEvidence }: { d: any; refresh: () => void; onEvidence: (id: string) => void }) {
  const s = d.study;
  const { run, running, current, earlier, base, start, cancel, anyCards } = useResearch(d, refresh);
  const [showPassage, setShowPassage] = useState(false);
  const [showChapter, setShowChapter] = useState(false);
  const [showEarlier, setShowEarlier] = useState(false);
  const [showSources, setShowSources] = useState(false);
  const [starting, setStarting] = useState(false);
  const sources = useQuery({
    queryKey: ["study-sources", s.id, base?.id],
    queryFn: () => Promise.all(d.runs.filter((r: any) => base && r.id >= base.id).map((r: any) => api(`/api/runs/${r.id}/sources`))).then((xs) => [...new Map(xs.flat().map((x: any) => [x.id, x])).values()]),
    enabled: showSources && !!base,
  });
  useEffect(() => {
    if (showChapter) document.querySelector(".rs-passage .passage .v.focus")?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [showChapter]);
  const missing: string[] = d.research?.missing ?? [];
  const olderProfile = !!base && d.research?.neutralReady === false;
  const cards = showEarlier ? [...current, ...earlier] : current;
  const begin = async (depth: "standard" | "deeper" | "fill") => {
    setStarting(true);
    await start(depth);
    setStarting(false);
  };

  const toWrite = () => void navigate(`/study/${s.id}/write`);
  usePrimaryShortcut(run ? toWrite : () => void begin("standard"), !starting);

  return (
    <div className="research-doc">
      <HeaderAction>
        {run ? (
          <button className="btn primary" onClick={toWrite}>Write <span className="kbd-hint">⌘↩</span></button>
        ) : (
          <button className="btn primary" onClick={() => void begin("standard")} disabled={starting}>{starting ? <Dots label="Starting research" /> : "Start research"}</button>
        )}
      </HeaderAction>

      <header className="rs-head">
        <p className="kicker">Study brief</p>
        <h1 className="rs-ref">{s.display_ref}</h1>
        {s.unit_label && <p className="rs-unit">{s.unit_label}</p>}
        <div className="rs-meta">
          {d.passage && (
            <button className="btn sm ghost rs-show-passage" onClick={() => setShowPassage((x) => !x)} aria-expanded={showPassage}>
              <BookOpen className="lucide" /> {showPassage ? "Hide the passage" : "Show the passage"}
            </button>
          )}
          <Provenance d={d} base={base} />
        </div>
        {/* In a wide window the passage is pinned at the top of the notebook; this is for narrow ones. */}
        {showPassage && d.passage && (
          <div className="rs-passage rise">
            <Passage passage={d.passage} showChapter={showChapter} cite={`${s.display_ref} (${d.passage.translation})`} />
            <div className="passage-foot">
              <span title={d.passage.copyright ?? undefined}>{d.passage.translation}</span>
              <button className="text-btn" onClick={() => setShowChapter((x) => !x)}>{showChapter ? "Just the passage" : "Whole chapter"}</button>
            </div>
          </div>
        )}
      </header>

      {!run && (
        <section className="rs-start">
          <h2>Research {s.display_ref}</h2>
          <p>A study brief, Scripture first:</p>
          <ol className="rs-includes">
            <li>Where it sits in the book</li>
            <li>Scripture on Scripture, and how it points to Jesus</li>
            <li>The {testamentOf(d) === "old" ? "Hebrew" : "Greek"} words behind the English</li>
            <li>The history and culture around it</li>
            <li>What your preachers and pastors say, each by name</li>
          </ol>
          <div className="rs-start-go">
            <button className="btn primary lg" onClick={() => void begin("standard")} disabled={starting}>{starting ? <Dots label="Starting research" /> : "Start research"}</button>
            <span>About a minute. It runs once, within your spending caps, and stays with this study.</span>
          </div>
        </section>
      )}

      {run && running && !anyCards && <ResearchProgress d={d} run={run} onCancel={cancel} />}

      {run && !running && !anyCards && (
        <section className="rs-start">
          <h2>{run.status === "cancelled" ? "Research was cancelled" : "Research didn't finish"}</h2>
          {run.error && <p>{run.error}</p>}
          {run.sourceCount > 0 && <p className="muted">{run.sourceCount} sources were gathered and kept. You can still write from the passage and your notes.</p>}
          <div className="rs-start-go">
            <button className="btn primary" onClick={() => void begin("standard")} disabled={starting}>Try again</button>
          </div>
        </section>
      )}

      {anyCards && (
        <>
          {running && <ResearchProgress d={d} run={run} onCancel={cancel} />}
          {!running && !olderProfile && missing.length > 0 && (
            <div className="notice">
              <span>The brief stopped before {missing.map((k) => MISSING_LABEL[k]).join(" and ")}. Everything else is saved.</span>
              <button className="btn sm secondary" onClick={() => void begin("fill")} disabled={starting}>Finish the brief</button>
            </div>
          )}
          <StudyBrief d={d} cards={cards} latestRunId={run?.id ?? null} running={running} onEvidence={onEvidence} onChanged={refresh} outline />
          {base && !running && (
            <footer className="rs-foot">
              <div className="rs-foot-actions">
                {!olderProfile && !d.research?.deeperDone && (
                  <button className="btn secondary" onClick={() => void begin("deeper")} disabled={starting} title="Neighboring chapters, more connections, and voices not yet heard. Runs once.">
                    Go deeper
                  </button>
                )}
                <button className="btn ghost" onClick={() => setShowSources((x) => !x)} aria-expanded={showSources}>
                  {showSources ? "Hide sources" : "Every source"} <ChevronDown className="lucide" style={{ transform: showSources ? "rotate(180deg)" : undefined }} />
                </button>
                {earlier.length > 0 && (
                  <button className="btn ghost" onClick={() => setShowEarlier((x) => !x)} aria-expanded={showEarlier}>
                    {showEarlier ? "Hide earlier research" : `${earlier.length} from earlier research`}
                  </button>
                )}
              </div>
              {olderProfile && (
                <p className="rs-older">
                  This brief came from an earlier version of research. To go deeper, refresh it; your highlights, notes, and writing stay as they are.
                  <button className="btn sm secondary" onClick={() => void begin("standard")} disabled={starting}>Refresh research</button>
                </p>
              )}
              {showSources && (
                <ul className="sources-list rise">
                  {sources.isLoading && <li><Dots label="Loading sources" /></li>}
                  {sources.data?.map((src: any) => (
                    <li key={src.id}>{src.url ? <a className="link" href={src.url} target="_blank" rel="noreferrer noopener">{src.title}</a> : src.title}</li>
                  ))}
                </ul>
              )}
            </footer>
          )}
        </>
      )}
    </div>
  );
}
