import { useEffect, useRef, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { ArrowRight, Search, Shuffle } from "lucide-react";
import { api, navigate, relDate, whenPhrase, queryClient } from "../api";
import { Link, useToast } from "../components/ui";
import { LaterList, useLater } from "../components/LaterList";
import { STATUS_WORD, describe } from "./Library";

type PriorStudy = { id: string; display_ref: string; created_local_date: string };
type Parsed = { ok: true; ref: string; display: string; verses: number; prior: PriorStudy[]; preview: { n: number; text: string }[] } | { ok: false; error: string; suggestion?: string };
type PassageChoice = {
  proposal: { ref: string; display: string; origin: string; label: string; source: string };
  proposalText: { n: number; text: string }[];
  translation: string;
  prior: PriorStudy[];
};
type TodayData = PassageChoice & {
  date: string;
  open: { id: string; display_ref: string; title: string | null } | null;
  sunday: { ref: string; display: string; origin: string; date: string } | null;
  passageError: string | null;
};

function calendarDate() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** The opening of a passage: enough to recognise it without hiding the next step. */
function Verses({ verses, translation, total }: { verses: { n: number; text: string }[]; translation?: string; total?: number }) {
  const shown: typeof verses = [];
  let chars = 0;
  for (const v of verses) {
    if (shown.length && chars + v.text.length > 260) break;
    shown.push(v);
    chars += v.text.length;
  }
  const more = (total ?? verses.length) - shown.length;
  return (
    <p className="today-text">
      {shown.map((v) => (
        <span key={v.n}>
          {verses.length > 1 && <sup>{v.n}</sup>}
          {v.text}{" "}
        </span>
      ))}
      {more > 0 ? (
        <span className="today-more faint">… {more} more verse{more === 1 ? "" : "s"}</span>
      ) : (
        translation && <span className="tiny faint today-translation">{translation}</span>
      )}
    </p>
  );
}

export function Today() {
  const toast = useToast();
  const [day, setDay] = useState(calendarDate);
  const today = useQuery({ queryKey: ["today", day], queryFn: () => api<TodayData>("/api/today"), refetchOnWindowFocus: true });
  const recent = useQuery({ queryKey: ["studies", "", ""], queryFn: () => api<any[]>("/api/studies") });
  const [choosing, setChoosing] = useState(false);
  const [shuffled, setShuffled] = useState<PassageChoice | null>(null);
  const visited = useRef<string[]>([]);
  const [refText, setRefText] = useState("");
  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [resolving, setResolving] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const parsedFor = useRef("");
  const currentInput = useRef(refText);
  currentInput.current = refText;
  const beginning = useRef(false);

  // A long-running desktop window must move to the new day, including after sleep.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const checkDay = () => {
      setDay(calendarDate());
      clearTimeout(timer);
      const now = new Date();
      const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      timer = setTimeout(checkDay, midnight.getTime() - now.getTime() + 100);
    };
    const onVisible = () => { if (document.visibilityState === "visible") checkDay(); };
    checkDay();
    window.addEventListener("focus", checkDay);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("focus", checkDay);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  useEffect(() => {
    setShuffled(null);
    visited.current = [];
  }, [day]);

  useEffect(() => {
    let cancelled = false;
    if (!refText.trim()) { setParsed(null); return; }
    const timer = setTimeout(() => {
      api<Parsed>("/api/parse-ref", { method: "POST", body: { text: refText } }).then((result) => {
        if (cancelled || currentInput.current !== refText) return;
        parsedFor.current = refText;
        setParsed(result);
      }).catch(() => {
        if (!cancelled && currentInput.current === refText) setParsed({ ok: false, error: "The passage lookup didn't finish. Your saved studies are still available. Try again." });
      });
    }, 200);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [refText]);

  const start = useMutation({
    mutationFn: (body: { ref: string; origin: string; parentStudyId?: string }) => api<{ id: string; warning?: string }>("/api/studies", { method: "POST", body }),
    onSuccess: (result) => {
      if (result.warning) toast(result.warning);
      // Reading and initial thoughts come first; research is an explicit choice in the study.
      queryClient.invalidateQueries({ queryKey: ["studies"] });
      queryClient.invalidateQueries({ queryKey: ["today"] });
      navigate(`/study/${result.id}`);
    },
    onError: (error: Error) => toast(error.message, "error"),
  });

  const d = today.data;
  const choice = shuffled ?? d;
  const p = choice?.proposal;
  const showChooser = choosing || (!today.isLoading && !p);
  const prior = showChooser ? (parsed?.ok ? parsed.prior : []) : (choice?.prior ?? []);
  const dateLine = new Date(`${d?.date ?? day}T12:00:00`).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
  const shuffle = useMutation({
    mutationFn: () => {
      const excluded = [...visited.current, ...(d?.proposal ? [d.proposal.ref] : []), ...(p ? [p.ref] : [])];
      return api<PassageChoice>(`/api/verses/shuffle?exclude=${encodeURIComponent(excluded.join(","))}`);
    },
    onSuccess: (result) => {
      visited.current = [...visited.current, result.proposal.ref].slice(-30);
      setShuffled(result);
      setChoosing(false);
    },
    onError: () => toast("Another passage couldn't load. Today's verse and saved studies are still available. Try shuffle again.", "error"),
  });

  const begin = async (parentStudyId?: string) => {
    if (beginning.current || start.isPending) return;
    beginning.current = true;
    let creating = false;
    try {
      if (showChooser) {
        const text = refText;
        if (!text.trim()) { input.current?.focus(); return; }
        setResolving(true);
        const result = parsedFor.current === text && parsed ? parsed : await api<Parsed>("/api/parse-ref", { method: "POST", body: { text } });
        // A slower response must never start a different passage from the one now in the input.
        if (text !== currentInput.current) return;
        parsedFor.current = text;
        setParsed(result);
        if (result.ok) {
          creating = true;
          await start.mutateAsync({ ref: result.ref, origin: "manual", parentStudyId });
        }
        else input.current?.focus();
      } else if (p) {
        creating = true;
        await start.mutateAsync({ ref: p.ref, origin: p.origin, parentStudyId });
      }
    } catch {
      // The mutation reports creation errors itself; lookup errors need their own recovery message.
      if (!creating && showChooser) toast("The passage couldn't be opened. Your saved studies are still available. Try this reference again.", "error");
    } finally {
      beginning.current = false;
      setResolving(false);
    }
  };

  const changeReference = (value: string) => {
    currentInput.current = value;
    setRefText(value);
    setParsed(null);
    parsedFor.current = "";
  };
  const backToToday = () => { setChoosing(false); setShuffled(null); changeReference(""); };
  const all = (recent.data ?? []).filter((study) => study.status !== "archived");
  const inProgress = all.filter((study) => study.status === "open").slice(0, 4);
  const finished = all.filter((study) => study.status !== "open").slice(0, 4);
  const later = useLater();
  const laterOpen = (later.data ?? []).filter((it) => !it.used_in_study_id);
  const busy = start.isPending || resolving || shuffle.isPending;

  return (
    <div className="today">
      <section className="today-hero" aria-label={showChooser ? "Choose a passage" : "Today's passage"}>
        <p className="today-date">{dateLine}{!showChooser && p && <><span aria-hidden="true"> · </span><span className="today-origin">{p.label}</span></>}</p>
        {today.isLoading && !showChooser && <div className="today-ref faint" role="status">Finding today's passage…</div>}
        {today.isError && <p className="notice" role="alert">Today's reading couldn't load. You can choose a passage or open a study below. <button className="link" onClick={() => today.refetch()}>Try again</button></p>}

        {!today.isLoading && !showChooser && p && (
          <div className="rise" key={p.ref} aria-live="polite">
            <h1 className="today-ref">{p.display}</h1>
            {!!choice?.proposalText.length && <Verses verses={choice.proposalText} translation={choice.translation} />}
            {d?.passageError && !shuffled && <p className="notice" role="alert">{d.passageError}</p>}
          </div>
        )}

        {showChooser && (
          <form onSubmit={(event) => { event.preventDefault(); void begin(); }}>
            <label className="sr-only" htmlFor="ref-input">Choose a passage</label>
            <div className="today-choose">
              <Search className="lucide" aria-hidden="true" />
              <input
                id="ref-input" ref={input} className="today-ref-input" autoFocus autoComplete="off" spellCheck={false}
                placeholder="Psalm 23" value={refText} onChange={(event) => changeReference(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Escape" && d?.proposal) backToToday(); }}
                aria-describedby="ref-hint"
              />
            </div>
            <div id="ref-hint" className={`today-hint ${parsed && !parsed.ok ? "error" : ""}`} aria-live="polite">
              {!refText.trim() && "A verse, a few verses, or a whole chapter."}
              {refText.trim() && !parsed && "Looking up the passage…"}
              {parsed?.ok && <>{parsed.display} · {parsed.verses} verse{parsed.verses === 1 ? "" : "s"}</>}
              {parsed && !parsed.ok && <>{parsed.error}{" "}{parsed.suggestion && <button type="button" className="link" onClick={() => changeReference(parsed.suggestion!)}>Did you mean {parsed.suggestion}?</button>}</>}
            </div>
            {parsed?.ok && parsed.preview.length > 0 ? (
              <div className="rise" key={parsed.ref}><Verses verses={parsed.preview} total={parsed.verses} /></div>
            ) : <p className="today-text placeholder" aria-hidden="true">&nbsp;</p>}
          </form>
        )}

        <div className="today-actions">
          <button className="btn primary lg" onClick={() => void begin()} disabled={busy || (today.isLoading && !showChooser) || (showChooser && !refText.trim())}>
            {start.isPending ? "Opening…" : resolving ? "Looking up…" : "Begin study"} <ArrowRight className="lucide" />
          </button>
          {!showChooser && p && <button className="btn ghost" disabled={busy} onClick={() => shuffle.mutate()}><Shuffle className="lucide" />{shuffle.isPending ? "Finding one…" : "Shuffle"}</button>}
          {!showChooser && <button className="btn ghost" disabled={busy} onClick={() => { setChoosing(true); setTimeout(() => input.current?.focus(), 0); }}><Search className="lucide" />Choose a passage</button>}
          {(showChooser || shuffled) && d?.proposal && <button className="btn ghost" disabled={busy} onClick={backToToday}>Back to today's verse</button>}
        </div>
        {!showChooser && p && (
          <p className="today-source">
            {p.source === "bible.com" && <>Daily verse from <a href="https://www.bible.com/verse-of-the-day" target="_blank" rel="noreferrer">Bible.com</a> · read in the {choice?.translation}</>}
            {p.source === "ourmanna" && <>Daily verse from <a href="https://www.ourmanna.com/" target="_blank" rel="noreferrer">OurManna</a> · read in the {choice?.translation}</>}
            {p.source === "local" && <>Today's pick from the app's Scripture collection, because the daily feeds were unavailable.</>}
          </p>
        )}

        {prior.length > 0 && <div className="prior-line rise">
          <span>You studied <Link className="link" to={`/study/${prior[0].id}`}>{prior[0].display_ref}</Link> {whenPhrase(prior[0].created_local_date)}.</span>
          <button className="btn sm ghost" disabled={busy} onClick={() => void begin(prior[0].id)}>Build on that study <ArrowRight className="lucide" /></button>
        </div>}
      </section>

      {(inProgress.length > 0 || d?.sunday) && (
        <section className="today-sec" aria-label="Continue">
          <h2>Continue</h2>
          <div className="today-list">
            {inProgress.map((study) => (
              <Link key={study.id} to={`/study/${study.id}`} className="today-row">
                <span className="today-row-ref">{study.display_ref}</span>
                <span className="today-row-what">{study.title || describe(study)}</span>
                <span className="today-row-when">{relDate(study.created_local_date)}</span>
                <ArrowRight className="lucide" aria-hidden="true" />
              </Link>
            ))}
            {d?.sunday && (
              <button className="today-row" disabled={busy} onClick={() => start.mutate({ ref: d.sunday!.ref, origin: "sunday_text" })}>
                <span className="today-row-ref">{d.sunday.display}</span>
                <span className="today-row-what">For Sunday, {new Date(d.sunday.date + "T12:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>
                <span className="today-row-when">Begin</span>
                <ArrowRight className="lucide" aria-hidden="true" />
              </button>
            )}
          </div>
        </section>
      )}

      {laterOpen.length > 0 && (
        <section className="today-sec" aria-label="Saved for later">
          <h2>Saved for later <Link className="sec-link" to="/library?tab=later">See all</Link></h2>
          <LaterList limit={2} capture={false} />
        </section>
      )}

      {finished.length > 0 && (
        <section className="today-sec" aria-label="Recent studies">
          <h2>Recent <Link className="sec-link" to="/library">Library</Link></h2>
          <div className="today-list">
            {finished.map((study) => (
              <Link key={study.id} to={`/study/${study.id}`} className="today-row">
                <span className="today-row-ref">{study.display_ref}</span>
                <span className="today-row-what">{study.title || study.firstLine || describe(study)}</span>
                <span className={`status-chip ${study.status}`}>{STATUS_WORD[study.status] ?? study.status}</span>
                <span className="today-row-when">{relDate(study.created_local_date)}</span>
              </Link>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
