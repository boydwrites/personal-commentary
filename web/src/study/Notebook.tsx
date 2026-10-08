// The notebook: one page of notes beside every stage of a study, under the passage you're studying.
//   The passage — pinned at the top while you research and write, so the verse is always in view.
//   Notes       — your words, before, during, and after the research, in one place. Lines you highlight anywhere
//                 (the passage, a finding, a source) land at your cursor as quotations marked ">", with their source.
//   Highlighted — findings you marked in the research, listed once there are any.
// A first draft reads all of it, and works without it too: writing here is never required.
import { useEffect, useRef, useState } from "react";
import { ChevronDown, History as HistoryIcon, Lightbulb, Quote, X } from "lucide-react";
import { api } from "../api";
import { useToast, Dots } from "../components/ui";
import { AnglePanel, type Angle } from "../components/WritingTools";
import { History } from "../components/History";
import { Mirror } from "../components/MarkEditor";
import { Passage } from "../components/Passage";
import { SECTION_LABEL, sectionOf, keepFromCard } from "../components/Brief";
import { flushPendingChanges } from "../desktop";
import { ADD_EVENT, addToNote, keptLines, type KeepRequest } from "../notes";
import { useStudyField } from "./fields";

const BEFORE_STARTERS = ["I notice", "I wonder", "This reminds me of", "A question I have:"];
const AFTER_STARTERS = ["I notice", "What surprised me:", "This changes how I read", "It matters because", "The question I'm left with:"];

/** Plain-text notes in which highlighted lines (">") are marked, and highlights from anywhere land at the cursor. */
export function NoteEditor({
  id, value, onChange, placeholder, starters, acceptsInserts, autoFocus, label, minRows = 3, className = "",
}: {
  id: string; value: string; onChange: (v: string) => void; placeholder: string; starters: string[];
  /** The one editor in the study that takes highlighted lines. */
  acceptsInserts: boolean; autoFocus?: boolean; label: string; minRows?: number; className?: string;
}) {
  const ta = useRef<HTMLTextAreaElement>(null);
  const caret = useRef<number | null>(null);
  const [focused, setFocused] = useState(false);
  const [lineEmpty, setLineEmpty] = useState(true);
  const valueRef = useRef(value);
  valueRef.current = value;

  // Size the editor to its text; the marked copy underneath sizes with it.
  const fit = () => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  };
  useEffect(fit, [value]);
  useEffect(() => {
    const el = ta.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let width = el.clientWidth;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      fit();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const trackCaret = () => {
    const el = ta.current;
    if (!el) return;
    caret.current = el.selectionStart;
    const before = el.value.slice(0, el.selectionStart);
    const lineStart = before.lastIndexOf("\n") + 1;
    const lineEnd = el.value.indexOf("\n", el.selectionStart);
    setLineEmpty(!el.value.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim());
  };
  const focusAt = (pos: number) =>
    setTimeout(() => {
      const el = ta.current;
      if (!el) return;
      el.focus({ preventScroll: true });
      el.setSelectionRange(pos, pos);
      caret.current = pos;
      trackCaret();
      el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }, 30);
  /** Inserts at the cursor (or the end); a block lands on its own paragraph with the cursor on a fresh line under it. */
  const insert = (text: string, block: boolean) => {
    const cur = valueRef.current;
    const at = caret.current ?? cur.length;
    let before = cur.slice(0, at);
    let after = cur.slice(at);
    if (block) {
      before = before.trimEnd();
      after = after.trimStart();
      const head = `${before}${before ? "\n\n" : ""}${text}\n`;
      onChange(`${head}${after ? `\n\n${after}` : ""}`);
      focusAt(head.length);
    } else {
      const space = before && !/\s$/.test(before) ? " " : "";
      const head = `${before}${space}${text} `;
      onChange(`${head}${after}`);
      focusAt(head.length);
    }
  };

  useEffect(() => {
    if (!acceptsInserts) return;
    const onAdd = (e: Event) => {
      e.preventDefault();
      insert(keptLines((e as CustomEvent<KeepRequest>).detail), true);
    };
    window.addEventListener(ADD_EVENT, onAdd);
    return () => window.removeEventListener(ADD_EVENT, onAdd);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [acceptsInserts]);
  useEffect(() => {
    if (autoFocus) focusAt(valueRef.current.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const showStarters = focused ? lineEmpty : !value.trim();
  return (
    // The whole box is the editor: a click on its margin puts the cursor at the end of your words.
    <div
      className={`ne ${className}`}
      onMouseDown={(e) => {
        const el = ta.current;
        if (!el || e.target === el || (e.target as HTMLElement).closest("button")) return;
        e.preventDefault();
        el.focus({ preventScroll: true });
        el.setSelectionRange(el.value.length, el.value.length);
        trackCaret();
      }}
    >
      <div className="mk-wrap">
        <Mirror value={value} />
        <textarea
          ref={ta}
          id={id}
          className="mk-text mk-input"
          spellCheck
          rows={minRows}
          aria-label={label}
          placeholder={placeholder}
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            caret.current = e.target.selectionStart;
          }}
          onSelect={trackCaret}
          onKeyUp={trackCaret}
          onClick={trackCaret}
          onFocus={() => {
            setFocused(true);
            trackCaret();
          }}
          onBlur={() => setTimeout(() => setFocused(false), 150)}
        />
      </div>
      {showStarters && (
        <div className="starters" aria-label="Start a line">
          {starters.map((st) => (
            <button key={st} className="starter" onMouseDown={(e) => e.preventDefault()} onClick={() => insert(st, false)}>
              {st}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const PASSAGE_KEY = "commentary.notebook.passage";
function savedOpen(): boolean {
  try {
    return localStorage.getItem(PASSAGE_KEY) !== "closed";
  } catch {
    return true;
  }
}

/** The passage at the top of the notebook: always in view while you research and write; select a line to highlight it. */
export function PassageCard({ d }: { d: any }) {
  const [open, setOpen] = useState(savedOpen);
  const s = d.study;
  if (!d.passage) return null;
  const toggle = () => {
    setOpen((x) => {
      try {
        localStorage.setItem(PASSAGE_KEY, x ? "closed" : "open");
      } catch {
        /* it just won't be remembered */
      }
      return !x;
    });
  };
  return (
    <section className={`nb-passage ${open ? "open" : "closed"}`} aria-label={`${s.display_ref}, the passage`}>
      <button className="nb-passage-head" onClick={toggle} aria-expanded={open} title={open ? "Fold the passage to one line" : "Show the whole passage"}>
        <span className="nb-passage-ref">{s.display_ref}</span>
        <span className="nb-passage-tr">{d.passage.translation}</span>
        <ChevronDown className="lucide nb-chev" />
      </button>
      <div className="nb-passage-text" onClick={() => !open && toggle()}>
        <Passage passage={d.passage} showChapter={false} cite={`${s.display_ref} (${d.passage.translation})`} />
      </div>
    </section>
  );
}

export function Notebook({ d, refresh, onEvidence, stage }: { d: any; refresh: () => void; onEvidence: (id: string) => void; stage: "read" | "research" | "write" }) {
  const toast = useToast();
  const s = d.study;
  const researched = d.cards.length > 0 || d.runs.length > 0;
  const field = useStudyField(s.id, "note");
  // Older studies kept first thoughts apart; migration 012 joined them into the notes.
  const [notes, setNotes] = useState<string>(s.note ?? "");
  const [angles, setAngles] = useState<{ list: Angle[]; seen: string[] } | null>(null);
  const [finding, setFinding] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [questionsOpen, setQuestionsOpen] = useState(false);
  const highlighted = d.cards.filter((c: any) => c.selected);
  const questions: string[] = [...d.runs].reverse().find((r: any) => r.writer_questions?.length)?.writer_questions ?? [];

  const change = (v: string) => {
    setNotes(v);
    field.change(v);
  };
  const unhighlight = async (id: string) => {
    try {
      await api(`/api/cards/${id}`, { method: "PATCH", body: { selected: false } });
      refresh();
    } catch (e: any) {
      toast(e.message, "error");
    }
  };
  const quote = (card: any) => {
    void addToNote(s.id, keepFromCard(card)).catch((e) => toast(e.message, "error"));
  };
  const findAngles = async (more = false) => {
    setFinding(true);
    try {
      if (!(await flushPendingChanges())) return;
      const seen = more && angles ? [...angles.seen, ...angles.list.map((a) => a.finding)] : [];
      const r = await api(`/api/studies/${s.id}/angles`, { method: "POST", body: { previous: seen } });
      setAngles({ list: r.angles, seen });
    } catch (e: any) {
      toast(e.message, "error");
    } finally {
      setFinding(false);
    }
  };
  // An angle highlights the finding it rests on and puts its question in your notes, to answer under it.
  const useAngle = async (a: Angle) => {
    if (a.card && !d.cards.find((c: any) => c.id === a.card!.id)?.selected) {
      try {
        await api(`/api/cards/${a.card.id}`, { method: "PATCH", body: { selected: true } });
        refresh();
      } catch (e: any) {
        toast(e.message, "error");
      }
    }
    try {
      await addToNote(s.id, { text: a.question, cite: null });
    } catch (e: any) {
      toast(`The question didn't save. Your notes are still here. Try adding it again. ${e.message}`, "error");
    }
    setAngles(null);
  };

  return (
    <div className="notebook">
      {stage !== "read" && <PassageCard d={d} />}

      <section className="nb-sec nb-notes">
        <div className="nb-h">
          <h2>Notes</h2>
          <span className="spacer" />
          {(s.note || notes) && (
            <button className="icon-btn sm" onClick={() => setHistoryOpen(true)} title="Earlier versions of your notes" aria-label="Earlier versions of your notes">
              <HistoryIcon className="lucide" />
            </button>
          )}
        </div>
        {s.question && <p className="legacy-question" title="Your question for this study">{s.question}</p>}
        <NoteEditor
          id="notes"
          label="Notes"
          value={notes}
          onChange={change}
          placeholder={researched ? "What catches you, and why does it matter?" : "What do you notice? What do you wonder?"}
          starters={researched ? AFTER_STARTERS : BEFORE_STARTERS}
          acceptsInserts
          autoFocus={stage === "read" && !notes.trim()}
          minRows={stage === "read" ? 6 : 5}
        />
        {(d.cards.length > 0 || questions.length > 0) && (
          <div className="nb-tools">
            {d.cards.length > 0 && !angles && (
              <button className="btn sm ghost" onClick={() => findAngles()} disabled={finding} title="Three ideas from your research, each with a question for you">
                {finding ? <Dots label="Finding angles" /> : <><Lightbulb className="lucide" /> Find an angle</>}
              </button>
            )}
            {questions.length > 0 && (
              <button className="btn sm ghost" onClick={() => setQuestionsOpen((x) => !x)} aria-expanded={questionsOpen} title="Questions to sit with, from the research">
                Questions
                <ChevronDown className="lucide" style={{ transform: questionsOpen ? "rotate(180deg)" : undefined }} />
              </button>
            )}
          </div>
        )}
        {questionsOpen && (
          <div className="nb-questions rise">
            {questions.map((q, i) => (
              <button key={i} className="nb-question" onClick={() => void addToNote(s.id, { text: q, cite: null }).catch((e) => toast(e.message, "error"))} title="Add to your notes, and answer it there">
                {q}
              </button>
            ))}
          </div>
        )}
        {angles && <AnglePanel angles={angles.list} busy={finding} onUse={useAngle} onMore={() => findAngles(true)} onClose={() => setAngles(null)} onEvidence={onEvidence} />}
      </section>

      {highlighted.length > 0 && (
        <section className="nb-sec">
          <div className="nb-h">
            <h2>Highlighted</h2>
            <span className="nb-count">{highlighted.length}</span>
          </div>
          <ul className="hl-list" aria-label="Highlighted findings">
            {highlighted.map((c: any) => (
              <li key={c.id} className="hl-item">
                <button className="hl-open" onClick={() => onEvidence(c.id)} title="Open this finding">
                  <span className="hl-kicker">{c.author_name ?? SECTION_LABEL[sectionOf(c)]}</span>
                  <span className="hl-title">{c.title}</span>
                </button>
                <button className="hl-act" onClick={() => quote(c)} title={c.quotes?.[0] ? "Quote its words in your notes" : "Add it to your notes"}>
                  <Quote className="lucide" />
                  <span className="sr-only">Quote in your notes</span>
                </button>
                <button className="hl-act" aria-label={`Remove the highlight from “${c.title}”`} title="Remove highlight" onClick={() => unhighlight(c.id)}>
                  <X className="lucide" />
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {historyOpen && (
        <History
          studyId={s.id}
          format={d.working?.format ?? s.format}
          currentHash={d.working?.text_hash ?? null}
          currentNote={notes}
          only="note"
          onClose={() => setHistoryOpen(false)}
          canRestorePost={false}
          onRestorePost={() => {}}
          onRestoreNote={(text) => {
            const before = notes;
            change(text);
            setHistoryOpen(false);
            toast("Restored that version of your notes.", { action: { label: "Undo", run: () => change(before) } });
          }}
        />
      )}
    </div>
  );
}
