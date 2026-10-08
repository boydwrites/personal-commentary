// Read: the passage, large, with your notes beside it in the notebook. Nothing from the research yet,
// so your own reading comes first. The next step — research — is always one click away.
import { useEffect, useState } from "react";
import { ArrowRight } from "lucide-react";
import { navigate, whenPhrase } from "../api";
import { Link, Dots } from "../components/ui";
import { Passage } from "../components/Passage";
import { testamentOf } from "../components/Brief";
import { OriginalWords, WordDrawer } from "../components/WordStudy";
import { HeaderAction, usePrimaryShortcut } from "./StudyHeader";
import { useResearch } from "./ResearchStage";

const ORIGIN: Record<string, string> = { votd: "Verse of the day", sunday_text: "For Sunday", later: "Saved for later", series: "Series" };

export function ReadStage({ d, refresh }: { d: any; refresh: () => void }) {
  const s = d.study;
  const { run, start } = useResearch(d, refresh);
  const [showChapter, setShowChapter] = useState(false);
  const [starting, setStarting] = useState(false);
  const [word, setWord] = useState<{ strong: string; at: string; lemma: string } | null>(null);
  useEffect(() => {
    if (showChapter) document.querySelector(".read-doc .passage .v.focus")?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [showChapter]);

  const research = async () => {
    if (run) return navigate(`/study/${s.id}/research`);
    setStarting(true);
    const ok = await start("standard");
    setStarting(false);
    if (ok) await navigate(`/study/${s.id}/research`);
  };
  usePrimaryShortcut(() => void research(), !starting);
  const findings = d.cards.length;
  const origin = ORIGIN[s.origin];

  return (
    <article className="read-doc">
      <HeaderAction>
        <button className="btn primary" onClick={() => void research()} disabled={starting}>
          {starting ? <Dots label="Starting research" /> : run ? <>Research <span className="kbd-hint">⌘↩</span></> : "Start research"}
        </button>
      </HeaderAction>

      {origin && <p className="kicker">{origin}</p>}
      <h1 className="read-ref">{s.display_ref}</h1>
      {s.title && <p className="read-title">{s.title}</p>}
      {(d.parent || d.prior.length > 0) && (
        <p className="read-context">
          {d.parent ? (
            <>Builds on your study of <Link className="link" to={`/study/${d.parent.id}`}>{d.parent.display_ref}</Link></>
          ) : (
            <>You studied <Link className="link" to={`/study/${d.prior[0].id}`}>{d.prior[0].display_ref}</Link> {whenPhrase(d.prior[0].created_local_date)}</>
          )}
        </p>
      )}
      {s.status === "archived" && <span className="chip">Archived</span>}

      {d.passageError && <p className="notice">The passage text didn't load ({d.passageError}). Your notes, research, and writing still work.</p>}
      {d.passage && <Passage passage={d.passage} showChapter={showChapter} cite={`${s.display_ref} (${d.passage.translation})`} />}
      {d.passage && (
        <div className="passage-foot">
          <span title={d.passage.copyright ?? undefined}>{d.passage.translation}</span>
          <button className="text-btn" onClick={() => setShowChapter((x) => !x)}>{showChapter ? "Just the passage" : "Read the whole chapter"}</button>
        </div>
      )}
      {d.passage && <OriginalWords studyId={s.id} onOpen={setWord} />}
      <WordDrawer word={word} onClose={() => setWord(null)} />

      <section className="next-card" aria-label="Next step">
        {run ? (
          <>
            <div>
              <h2>{findings ? `The study brief is ready · ${findings} findings` : "Research has started"}</h2>
            </div>
            <button className="btn secondary" onClick={() => void navigate(`/study/${s.id}/research`)}>Open the research <ArrowRight className="lucide" /></button>
          </>
        ) : (
          <>
            <div>
              <h2>When you're ready, research the passage</h2>
              <p>Scripture on Scripture, the {testamentOf(d) === "new" ? "Greek" : "Hebrew"} words, history, and the voices you trust. About a minute; it runs once.</p>
            </div>
            <button className="btn secondary" onClick={() => void research()} disabled={starting}>{starting ? <Dots label="Starting research" /> : "Start research"}</button>
          </>
        )}
      </section>
    </article>
  );
}
