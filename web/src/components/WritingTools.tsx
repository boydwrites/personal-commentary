// Helpers beside the piece and the notebook: refining (Polish, Shorten, Clarify, or your own direction), reviewing
// suggested edits one by one, finding an angle in the research, and what a draft drew on.
import { useMemo, useState } from "react";
import { ArrowRight, Check, ChevronDown, RefreshCw, Wand2, X } from "lucide-react";
import { wordDiff } from "../diff";
import { Dots } from "./ui";
import { SECTION_LABEL } from "./Brief";

export type RefinementMode = "polish" | "shorten" | "clarify";

const MODES: { mode: RefinementMode; label: string; title: string }[] = [
  { mode: "polish", label: "Polish", title: "Smooth wording and flow while keeping your voice" },
  { mode: "shorten", label: "Shorten", title: "Cut repetition and keep the heart of it" },
  { mode: "clarify", label: "Clarify", title: "Make the thought easier to follow" },
];

/** Refine the piece. Every suggestion is shown as edits you accept or leave, and applying offers Undo. */
export function RefineBar({ disabled, busy, onRefine }: { disabled: boolean; busy: boolean; onRefine: (mode: RefinementMode, instruction?: string) => void }) {
  const [instruction, setInstruction] = useState("");
  const [custom, setCustom] = useState(false);
  return (
    <section className="refine" aria-label="Refine your piece">
      <div className="refine-row">
        <span className="refine-label"><Wand2 className="lucide" aria-hidden="true" />{busy ? <>Preparing suggestions <Dots /></> : "Refine"}</span>
        <div className="seg" role="group" aria-label="Refinements">
          {MODES.map((m) => (
            <button key={m.mode} disabled={disabled} onClick={() => onRefine(m.mode)} title={m.title}>{m.label}</button>
          ))}
        </div>
        <button className="btn sm ghost" disabled={disabled} aria-expanded={custom} onClick={() => setCustom((v) => !v)}>Ask for a change…</button>
      </div>
      {custom && (
        <form className="refine-custom rise" onSubmit={(e) => { e.preventDefault(); if (!disabled && instruction.trim()) onRefine("polish", instruction); }}>
          <label htmlFor="refine-instruction" className="sr-only">What would you like to change?</label>
          <textarea id="refine-instruction" rows={2} maxLength={1500} value={instruction} onChange={(e) => setInstruction(e.target.value)} disabled={disabled} placeholder="For example: keep my ending, make the opening warmer, and cut repeated ideas." autoFocus />
          <div className="row">
            <button className="btn sm primary" type="submit" disabled={disabled || !instruction.trim()}>Suggest edits</button>
            <button className="btn sm ghost" type="button" onClick={() => setCustom(false)}>Cancel</button>
          </div>
        </form>
      )}
    </section>
  );
}

// ---------------- Find an angle ----------------

export interface Angle {
  item: string;
  finding: string;
  why_it_lands: string;
  meets_you: string | null;
  question: string;
  card: { id: string; title: string; section: string; author: string | null } | null;
}

export function AnglePanel({ angles, busy, onUse, onMore, onClose, onEvidence }: { angles: Angle[]; busy: boolean; onUse: (a: Angle) => void; onMore: () => void; onClose: () => void; onEvidence: (id: string) => void }) {
  return (
    <section className="angles rise" aria-label="Angles">
      <div className="angles-head">
        <h3>Three ways in</h3>
        <span className="spacer" />
        <button className="btn sm ghost" onClick={onMore} disabled={busy}>
          {busy ? <Dots label="Finding more" /> : <><RefreshCw className="lucide" /> Three more</>}
        </button>
        <button className="icon-btn sm" aria-label="Hide angles" onClick={onClose}>
          <X className="lucide" />
        </button>
      </div>
      <p className="angles-note">Choose one to highlight the finding it rests on and add its question to your notes.</p>
      <div className="angle-list" style={{ opacity: busy ? 0.5 : 1 }}>
        {angles.map((a, i) => (
          <article key={i} className="angle rise" style={{ animationDelay: `${i * 70}ms` }}>
            {a.card && (
              <button className="angle-from" onClick={() => onEvidence(a.card!.id)} title="Open the finding">
                {SECTION_LABEL[a.card.section] ?? "Research"} · {a.card.author ? `${a.card.author} · ` : ""}{a.card.title}
              </button>
            )}
            <p className="angle-finding">{a.finding}</p>
            <p className="angle-why">{a.why_it_lands}</p>
            {a.meets_you && <p className="angle-you">{a.meets_you}</p>}
            <button className="angle-q" disabled={busy} onClick={() => onUse(a)}>
              <span>{a.question}</span>
              <ArrowRight className="lucide" />
            </button>
          </article>
        ))}
      </div>
    </section>
  );
}

// ---------------- Suggested edits ----------------

export interface SharpenResult {
  base_hash: string;
  original: string[];
  parts: string[];
  changes: { part_index: number; kind: string; before: string; after: string; reason: string; separable: boolean }[];
  unchanged: boolean;
  notes: string;
}

const KIND: Record<string, string> = {
  grammar: "Grammar", spelling: "Spelling", punctuation: "Punctuation", tighten: "Tighter", clarity: "Clearer", first_line: "First line", flow: "Flow", length: "Length",
};

/** Applies the chosen edits. All of them → the editor's version; some → each chosen edit replaced in your text. */
export function applySharpen(r: SharpenResult, on: boolean[]): string[] {
  if (on.every(Boolean)) return r.parts;
  return r.original.map((orig, i) => {
    let text = orig;
    r.changes.forEach((c, k) => {
      if (c.part_index === i && on[k] && c.separable) text = text.replace(c.before, () => c.after);
    });
    return text;
  });
}

export function SharpenPanel({ result, multiPart, prose = false, disabled = false, onApply, onClose }: { result: SharpenResult; multiPart: boolean; prose?: boolean; disabled?: boolean; onApply: (parts: string[]) => void; onClose: () => void }) {
  const [on, setOn] = useState<boolean[]>(() => result.changes.map(() => true));
  const preview = useMemo(() => applySharpen(result, on), [result, on]);
  const some = result.changes.length === 0 || on.some(Boolean);
  const all = on.every(Boolean);
  return (
    <section className={`suggest rise ${prose ? "prose" : ""}`} aria-label="Suggested edits">
      <div className="suggest-head">
        <h3>Suggested edits</h3>
        <span className="spacer" />
        <button className="icon-btn sm" aria-label="Close suggestions" disabled={disabled} onClick={onClose}>
          <X className="lucide" />
        </button>
      </div>
      <div className="suggest-preview">
        {preview.map((p, i) => (
          <div key={i} className="suggest-part">
            {multiPart && <span className="tag">{i + 1}/{preview.length}</span>}
            {wordDiff(result.original[i] ?? "", p).map(([op, t], j) => (op === 0 ? <span key={j}>{t}</span> : op === 1 ? <ins key={j}>{t}</ins> : <del key={j}>{t}</del>))}
          </div>
        ))}
      </div>
      {result.changes.length > 0 && (
        <ul className="suggest-changes">
          {result.changes.map((c, k) => {
            const locked = !c.separable;
            return (
              <li key={k} className={on[k] ? "" : "off"}>
                <label>
                  <input
                    type="checkbox"
                    checked={on[k]}
                    disabled={disabled || locked}
                    onChange={(e) => setOn((cur) => cur.map((x, i) => (i === k ? e.target.checked : result.changes[i].separable ? x : false)))}
                  />
                  <span className="kind">{KIND[c.kind] ?? c.kind}</span>
                  <span className="what">{c.before ? <del>{c.before}</del> : null} {c.after ? <ins>{c.after}</ins> : null}</span>
                </label>
                <span className="why">{c.reason}{locked ? " · included when all edits are selected" : ""}</span>
              </li>
            );
          })}
        </ul>
      )}
      {result.notes && <p className="suggest-notes">{result.notes}</p>}
      <div className="row suggest-actions">
        <button className="btn sm primary" disabled={!some || disabled} onClick={() => onApply(preview)}>
          <Check className="lucide" /> {all ? "Use all edits" : "Use these edits"}
        </button>
        <button className="btn sm ghost" disabled={disabled} onClick={onClose}>Keep mine</button>
        {!all && <button className="btn sm ghost" disabled={disabled} onClick={() => setOn(result.changes.map(() => true))}>Select all</button>}
      </div>
    </section>
  );
}

// ---------------- What the draft drew on ----------------

export function DraftNotes({ draft, disabled = false, onEvidence, onOpening }: { draft: any; disabled?: boolean; onEvidence: (id: string) => void; onOpening: (line: string) => void }) {
  const [showLeft, setShowLeft] = useState(false);
  const drew: any[] = draft.drew_on ?? [];
  const left: any[] = draft.left_out ?? [];
  const openings: string[] = draft.alternate_openings ?? [];
  if (!drew.length && !left.length && !openings.length) return null;
  return (
    <div className="draft-notes rise">
      {drew.length > 0 && (
        <div>
          <h4>Drew on</h4>
          <div className="chips">
            {drew.map((x) => (
              <button key={x.card_id} className="chip-btn" onClick={() => onEvidence(x.card_id)} title={x.why}>
                {x.author ? `${x.author}: ` : ""}{x.title}
              </button>
            ))}
          </div>
        </div>
      )}
      {openings.length > 0 && (
        <div>
          <h4>Other first lines</h4>
          <div className="openings">
            {openings.map((o, i) => (
              <button key={i} className="opening" disabled={disabled} onClick={() => onOpening(o)} title="Use this as the first line">
                {o}
              </button>
            ))}
          </div>
        </div>
      )}
      {left.length > 0 && (
        <div>
          <button className="btn sm ghost" onClick={() => setShowLeft((x) => !x)} aria-expanded={showLeft}>
            Left out of this draft ({left.length}) <ChevronDown className="lucide" style={{ transform: showLeft ? "rotate(180deg)" : undefined }} />
          </button>
          {showLeft && (
            <ul className="left-out rise">
              {left.map((x, i) => (
                <li key={i}>
                  <span className="serif">{x.text}</span>
                  <span className="why">{x.reason}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
