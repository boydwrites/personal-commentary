// A study's one bar: where you came from, which passage, the three steps of a study, whether your words are saved,
// and the next step — always in the same place.
import { createContext, useContext, useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronLeft, NotebookPen } from "lucide-react";
import { navigate } from "../api";
import { Link, Menu, type MenuItem } from "../components/ui";
import { flushPendingChanges } from "../desktop";
import { useSaveState } from "../saveStatus";
import { backTarget } from "../backTo";
import { formatLabel } from "./pieces";
import { TitleEditor } from "./TitleEditor";

export type Stage = "read" | "research" | "write";

/** Where each stage puts its next-step button: the header's right edge. */
export const CtaSlot = createContext<HTMLElement | null>(null);

export function HeaderAction({ children }: { children: ReactNode }) {
  const slot = useContext(CtaSlot);
  return slot ? createPortal(children, slot) : null;
}

/** ⌘↩ runs the stage's next step. */
export function usePrimaryShortcut(run: (() => void) | undefined, enabled: boolean) {
  const ref = useRef({ run, enabled });
  ref.current = { run, enabled };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key !== "Enter") return;
      const { run, enabled } = ref.current;
      if (!run || !enabled) return;
      e.preventDefault();
      run();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

export function stepsOf(d: any) {
  const s = d.study;
  const run = d.runs.at(-1);
  const running = !!run && (run.status === "queued" || run.status === "running");
  const written = (d.availableFormats?.length ?? 0) > 0 || !!d.working?.parts?.some((p: string) => p.trim());
  return [
    { key: "read" as const, label: "Read", done: !!s.note?.trim() || d.runs.length > 0, detail: null as string | null, running: false },
    { key: "research" as const, label: "Research", done: d.cards.length > 0, detail: null, running },
    { key: "write" as const, label: "Write", done: written, detail: written ? formatLabel(d.working?.format ?? s.format) : null, running: false },
  ];
}

export function StudyHeader({
  d, stage, menu, setSlot, notebookToggle, finished,
}: {
  d: any;
  stage: Stage | "finished";
  menu: MenuItem[];
  setSlot: (el: HTMLElement | null) => void;
  /** Below the wide layout, the notebook opens as a sheet from here. */
  notebookToggle?: { count: number; open: () => void } | null;
  finished?: ReactNode;
}) {
  const s = d.study;
  const back = backTarget();
  const steps = stepsOf(d);
  const go = (key: Stage) => {
    if (key !== stage) void navigate(`/study/${s.id}/${key}`);
  };
  return (
    <header className="sh">
      <div className="sh-left">
        <Link to={back.to} className="sh-back" title={`Back to ${back.label}  ⌘${back.label === "Today" ? 1 : 2}`}>
          <ChevronLeft className="lucide" />
          <span>{back.label}</span>
        </Link>
        <div className="sh-title">
          <span className="sh-ref">{s.display_ref}</span>
          <TitleEditor study={s} triggerClassName={`sh-sub sh-title-btn ${s.title ? "" : "untitled"}`} trigger={s.title ?? "Untitled"} />
        </div>
      </div>

      <nav className="stepper" aria-label="Steps of this study">
        {steps.map((st, i) => {
          const current = st.key === stage;
          return (
            <span key={st.key} className="stp-wrap">
              {i > 0 && <span className={`stp-line ${steps[i - 1].done ? "done" : ""}`} aria-hidden="true" />}
              <button className={`stp ${current ? "current" : ""} ${st.done ? "done" : ""}`} aria-current={current ? "step" : undefined} onClick={() => go(st.key)}>
                <span className="stp-dot" aria-hidden="true">
                  {st.running ? <span className="spin" /> : st.done && !current ? <Check className="lucide" /> : i + 1}
                </span>
                <span className="stp-label">{st.label}</span>
                {st.running && <span className="sr-only">(researching)</span>}
              </button>
            </span>
          );
        })}
      </nav>

      <div className="sh-right">
        {finished}
        <SaveIndicator />
        {notebookToggle && (
          <button className="btn sm ghost nb-toggle-btn" onClick={notebookToggle.open} title="Your notebook">
            <NotebookPen className="lucide" />
            <span className="nb-toggle-label">Notebook</span>
            {notebookToggle.count > 0 && <span className="badge">{notebookToggle.count}</span>}
          </button>
        )}
        <Menu label="Study options" items={menu} />
        <div className="sh-cta" ref={setSlot} />
      </div>
    </header>
  );
}

function SaveIndicator() {
  const state = useSaveState();
  if (state === "failed")
    return (
      <button className="save-ind failed" onClick={() => void flushPendingChanges()} title="Some words didn't save. They're still on screen. Click to try again.">
        Not saved · Retry
      </button>
    );
  return (
    <span className={`save-ind ${state}`} aria-live="polite">
      {state === "saved" ? <><Check className="lucide" /> Saved</> : "Saving…"}
    </span>
  );
}
