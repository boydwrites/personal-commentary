// Write: choose what to make, get a first draft from your notebook, then make it yours — edit freely, refine,
// check it, and finish (or post to X). The notebook and the check sit beside the piece.
import { useState, type ReactNode } from "react";
import { ArrowLeft, ArrowUpRight, Check, ChevronDown, Copy, History as HistoryIcon, Plus, ShieldCheck, Undo2, X } from "lucide-react";
import { navigate, queryClient } from "../api";
import { AutoGrow, Dots, Menu } from "../components/ui";
import { MarkEditor } from "../components/MarkEditor";
import { VoiceNote } from "../components/Voice";
import { Findings } from "../components/Findings";
import { PublishFlow } from "../components/PublishFlow";
import { History } from "../components/History";
import { DraftNotes, RefineBar, SharpenPanel } from "../components/WritingTools";
import { countPost } from "../../../shared/counting.ts";
import { isXFormat, type WritingFormat } from "../../../shared/writing.ts";
import { ownWords } from "../notes";
import { HeaderAction, usePrimaryShortcut } from "./StudyHeader";
import { StageFrame, type Layout } from "./StageFrame";
import { Notebook } from "./Notebook";
import { PIECES, X_SHAPES, formatLabel, inSentence, pieceOf } from "./pieces";
import { useWriting, type Writing } from "./useWriting";
import { markJustFinished } from "./Finished";

let chooseNext: string | null = null;
/** The next time this study's Write stage opens, it opens on the choice of piece (from the finished page, say). */
export function openChooserNext(studyId: string) {
  chooseNext = studyId;
}

export function WriteStage({ d, refresh, onEvidence, layout }: { d: any; refresh: () => void; onEvidence: (id: string) => void; layout: Layout }) {
  const w = useWriting(d, refresh);
  const s = d.study;
  const [tab, setTab] = useState<"notebook" | "check">("notebook");
  const [choosing, setChoosing] = useState(() => {
    const open = chooseNext === s.id;
    chooseNext = null;
    return open;
  });
  const [historyOpen, setHistoryOpen] = useState(false);
  const showChooser = choosing || (!w.hasText && !w.writingOwn && w.busy !== "draft");
  const openCount = w.openBlockers + w.openJudgments;
  const showCheck = () => {
    setTab("check");
    if (!layout.wide) layout.setSheet(true);
  };
  const showNotebook = () => {
    setTab("notebook");
    if (!layout.wide) layout.setSheet(true);
    setTimeout(() => document.getElementById("notes")?.focus(), 80);
  };
  const finish = async () => {
    const r = await w.finish();
    if (!r) return;
    markJustFinished(s.id, r.where);
    void navigate(`/study/${s.id}`);
  };

  // ---- The one next step ----
  type Action = { label: ReactNode; run?: () => void; href?: string; tone?: "primary" | "x" | "secondary"; disabled?: boolean };
  let action: Action;
  if (w.published) action = { label: <>View on X <ArrowUpRight className="lucide" /></>, href: d.publish.posts[0]?.x_url, tone: "x" };
  else if (w.partlyPosted) action = { label: "Finish posting", run: () => w.setPublishing(true), tone: "x" };
  else if (!w.hasText) {
    action = w.canDraft
      ? { label: w.busy === "draft" ? <Dots label="Drafting" /> : "Create first draft", run: () => void w.draftNow("edit"), disabled: !!w.busy }
      : { label: "Research first", run: () => void navigate(`/study/${s.id}/research`), tone: "secondary" };
  } else if (w.xFormat) {
    if (!w.checked) action = { label: w.busy === "check" ? <Dots label="Checking" /> : "Check", run: async () => { if (await w.check()) showCheck(); }, disabled: !!w.busy };
    else if (!w.gate?.canPublish) action = { label: openCount ? `Resolve ${openCount}` : "See the check", run: showCheck, disabled: !!w.busy };
    else action = { label: "Post to X", run: () => w.setPublishing(true), tone: "x", disabled: !!w.busy };
  } else if (s.status === "saved" || s.status === "published") action = { label: "Done", run: () => void navigate(`/study/${s.id}`), disabled: !!w.busy };
  else action = { label: w.busy === "finish" ? <Dots label="Finishing" /> : "Finish", run: () => void finish(), disabled: !!w.busy };
  // In the chooser, ⌘↩ creates the first draft of the chosen piece once the notebook is ready.
  usePrimaryShortcut(showChooser ? (w.canDraft ? () => void w.draftNow("edit") : undefined) : action.run, showChooser ? !w.busy : !action.disabled);

  const main = showChooser ? (
    <PieceChooser d={d} w={w} back={choosing && w.hasText ? () => setChoosing(false) : null} onPick={async (f) => {
      await w.changeFormat(f);
      setChoosing(false);
    }} onNotebook={showNotebook} />
  ) : (
    <Editor d={d} w={w} onEvidence={onEvidence} onChoose={() => setChoosing(true)} onHistory={() => setHistoryOpen(true)} onCheck={showCheck} />
  );

  const aside = (
    <div className="side">
      <div className="side-tabs" role="tablist" aria-label="Beside your piece">
        <button role="tab" aria-selected={tab === "notebook"} onClick={() => setTab("notebook")}>Notebook</button>
        <button role="tab" aria-selected={tab === "check"} onClick={() => setTab("check")}>
          Check{openCount > 0 && <span className="badge warn">{openCount}</span>}{w.checked && !openCount && <Check className="lucide tab-ok" />}
        </button>
      </div>
      {tab === "notebook" ? <Notebook d={d} refresh={refresh} onEvidence={onEvidence} stage="write" /> : <CheckPanel d={d} w={w} />}
    </div>
  );

  return (
    <>
      <HeaderAction>
        {showChooser ? null : action.href ? (
          <a className={`btn ${action.tone ?? "primary"}`} href={action.href} target="_blank" rel="noreferrer noopener">{action.label}</a>
        ) : (
          <button className={`btn ${action.tone ?? "primary"}`} onClick={action.run} disabled={action.disabled}>{action.label}</button>
        )}
      </HeaderAction>
      <StageFrame layout={layout} kind="write" main={main} aside={aside} asideLabel="Notebook and check" />
      {historyOpen && (
        <History
          studyId={s.id}
          format={w.format}
          currentHash={w.hash}
          currentNote={s.note ?? ""}
          only="post"
          onClose={() => setHistoryOpen(false)}
          canRestorePost={!w.published}
          onRestorePost={(v) => {
            w.restoreVersion(v);
            setHistoryOpen(false);
          }}
          onRestoreNote={() => {}}
        />
      )}
      {w.publishing && w.xFormat && (
        <PublishFlow
          open={w.publishing}
          onClose={() => {
            w.setPublishing(false);
            refresh();
            queryClient.invalidateQueries({ queryKey: ["studies"] });
            queryClient.invalidateQueries({ queryKey: ["today"] });
          }}
          study={s}
          working={{ parts: w.parts, source_reply: d.postSourceReply === false ? "" : w.reply, text_hash: w.hash }}
          publish={d.publish}
          handle={d.xHandle}
          onChanged={refresh}
        />
      )}
    </>
  );
}

// ---------------- Choosing what to make ----------------

function PieceChooser({ d, w, back, onPick, onNotebook }: { d: any; w: Writing; back: (() => void) | null; onPick: (f: WritingFormat) => void; onNotebook: () => void }) {
  const started = new Set<string>((d.availableFormats ?? []).map((f: string) => (isXFormat(f) ? "x" : f)));
  const current = pieceOf(w.format);
  const highlights = d.cards.filter((c: any) => c.selected).length;
  // Pieces already written from this study, other than this one: a new draft builds on them.
  const others = PIECES.filter((p) => started.has(p.kind) && p.kind !== current.kind).map((p) => inSentence(p.label));
  const from = [
    w.noteWords > 0 ? `your ${w.noteWords} word${w.noteWords === 1 ? "" : "s"}` : null,
    highlights ? `${highlights} highlight${highlights === 1 ? "" : "s"}` : null,
    others.length ? `your ${others.join(" and ")}` : null,
  ].filter(Boolean) as string[];
  const fromText = from.length > 1 ? `${from.slice(0, -1).join(", ")} and ${from.at(-1)}` : from[0];
  return (
    <section className="chooser rise">
      {back && (
        <button className="btn sm ghost chooser-back" onClick={back}>
          <ArrowLeft className="lucide" /> Back to your {inSentence(formatLabel(w.format))}
        </button>
      )}
      <p className="kicker">Write</p>
      <h1>{started.size ? "What else will you make from this study?" : "What will you make from this study?"}</h1>
      {(["For you", "To share"] as const).map((group) => (
        <div key={group} className="piece-group">
          <h2>{group}</h2>
          <div className="piece-grid">
            {PIECES.filter((p) => p.audience === group).map((p) => {
              const on = current.kind === p.kind;
              return (
                <button key={p.kind} className={`piece ${on ? "on" : ""}`} aria-pressed={on} disabled={!!w.busy}
                  onClick={() => onPick(p.kind === "x" ? (isXFormat(w.format) ? w.format : "single") : p.format)}>
                  <span className="piece-top">
                    <p.Icon className="lucide" />
                    <strong>{p.label}</strong>
                    {started.has(p.kind) && <span className="chip">Started</span>}
                    {on && <Check className="lucide piece-check" />}
                  </span>
                  <span className="piece-desc">{p.description}</span>
                  <span className="piece-shape">{p.shape}</span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
      {w.xFormat && <XShapes d={d} w={w} />}
      <div className="chooser-go">
        {w.canDraft ? (
          <button className="btn primary lg" onClick={() => void w.draftNow("edit")} disabled={!!w.busy}>
            {w.busy === "draft" ? <Dots label="Drafting" /> : <>Create a first draft</>}
          </button>
        ) : (
          <button className="btn secondary lg" onClick={() => void navigate(`/study/${d.study.id}/research`)}>Research the passage first</button>
        )}
        <button className="btn ghost lg" onClick={() => w.setWritingOwn(true)} disabled={!!w.busy}>Write it myself</button>
      </div>
      <p className="chooser-note">
        {!w.canDraft
          ? "A draft needs something to stand on: the research, or a few thoughts in your notebook."
          : fromText
            ? `Drafts from ${fromText}, with the research behind them.`
            : <>Drafts from the research. <button className="text-btn inline" onClick={onNotebook}>Add a thought</button> to steer it.</>}
      </p>
      {w.busy === "draft" && <div className="draft-loading"><Dots label="Drafting" /><p>Shaping a first {inSentence(formatLabel(w.format))}{from.length ? ` from ${fromText}` : " from the research"}.</p></div>}
    </section>
  );
}

function XShapes({ d, w }: { d: any; w: Writing }) {
  const shapes = X_SHAPES.filter((x) => x.format !== "long" || d.premium || w.format === "long");
  return (
    <div className="x-shapes">
      <span>Shape</span>
      <div className="seg" role="group" aria-label="X post shape">
        {shapes.map((x) => (
          <button key={x.format} aria-pressed={w.format === x.format} disabled={!!w.busy} onClick={() => void w.changeFormat(x.format)}>{x.label}</button>
        ))}
      </div>
    </div>
  );
}

// ---------------- The piece ----------------

const PLACEHOLDER: Record<string, string> = {
  journal: "Today I studied…",
  devotional: "Begin with the passage, then share what it teaches…",
  notes: "## An idea from the passage\nWhat you saw, and the verse or source that shows it…",
};

function Editor({ d, w, onEvidence, onChoose, onHistory, onCheck }: { d: any; w: Writing; onEvidence: (id: string) => void; onChoose: () => void; onHistory: () => void; onCheck: () => void }) {
  const [aboutOpen, setAboutOpen] = useState(false);
  const piece = pieceOf(w.format);
  const busy = !!w.busy;
  const locked = w.published || busy;
  const started = new Set<string>((d.availableFormats ?? []).map((f: string) => (isXFormat(f) ? "x" : f)));
  const words = ownWords(w.parts.join("\n\n"));
  return (
    <div className="writer rise">
      <div className="writer-bar">
        <div className="piece-tabs" role="tablist" aria-label="Pieces from this study">
          {PIECES.filter((p) => started.has(p.kind) || p.kind === piece.kind).map((p) => {
            const on = p.kind === piece.kind;
            return (
              <button key={p.kind} role="tab" aria-selected={on} className={`piece-tab ${on ? "on" : ""}`} disabled={busy && !on}
                onClick={() => !on && void w.changeFormat(p.kind === "x" ? "single" : p.format)}
                title={on ? undefined : `Switch to your ${inSentence(p.label)}. Its draft is kept as you left it.`}>
                <p.Icon className="lucide" /> {on ? formatLabel(w.format) : p.label}
              </button>
            );
          })}
          <button className="piece-tab add" onClick={onChoose} disabled={busy} title="Make another piece from this study: study notes, a devotional, an X post…">
            <Plus className="lucide" /> Another piece
          </button>
        </div>
        {w.xFormat && !w.published && <XShapes d={d} w={w} />}
        {w.published && <span className="chip good"><Check className="lucide" /> Posted</span>}
        <span className="spacer" />
        {!w.xFormat && <span className="writer-count">{words} words</span>}
        {w.undo && !w.published && (
          <button className="btn sm ghost" onClick={w.undoLast} disabled={busy} title="Undo the last change to your piece">
            <Undo2 className="lucide" /> Undo
          </button>
        )}
        <button className="icon-btn" onClick={onHistory} disabled={busy} title="Earlier versions" aria-label="Earlier versions">
          <HistoryIcon className="lucide" />
        </button>
        <button className="icon-btn" onClick={() => void w.copyText()} disabled={!w.hasText} title="Copy" aria-label="Copy">
          <Copy className="lucide" />
        </button>
        <Menu
          label="More for this piece"
          items={[
            { label: w.busy === "alt" ? "Finding another angle…" : "Try another angle", onSelect: () => void w.draftNow("alternate"), disabled: w.published || !w.canDraft || busy || !d.lastDraft },
            { label: "Draft it again", onSelect: () => void w.draftNow("edit"), disabled: w.published || !w.canDraft || busy },
            { label: w.compare ? "Hide the comparison" : "Compare with my notebook", onSelect: () => w.setCompare((x) => !x), disabled: !w.hasText },
            { label: "Run a full check", onSelect: async () => { if (await w.check()) onCheck(); }, disabled: w.published || !w.hasText || busy },
            "divider",
            { label: "Earlier versions…", onSelect: onHistory, disabled: busy },
          ]}
        />
      </div>

      {w.busy === "draft" && !w.hasText ? (
        <div className="draft-loading"><Dots label="Drafting" /><p>Shaping your notebook into a first {inSentence(formatLabel(w.format))}.</p></div>
      ) : w.xFormat ? (
        <div className="thread" style={{ opacity: w.busy === "draft" ? 0.5 : 1 }}>
          {w.parts.map((text, i) => (
            <XPost
              key={i}
              id={`part-${i}`}
              text={text}
              name={d.xDisplayName}
              handle={d.xHandle}
              limit={w.format === "long" ? "long" : "single"}
              autoFocus={w.writingOwn && i === 0 && !w.hasText}
              placeholder={i === 0 ? "Write your post…" : "Continue the thread…"}
              tag={w.format === "thread" && w.parts.length > 1 ? `${i + 1}/${w.parts.length}` : undefined}
              readOnly={locked}
              onChange={(v) => w.setPart(i, v)}
              onRemove={w.format === "thread" && w.parts.length > 1 && !locked ? () => w.removePart(i) : undefined}
            />
          ))}
          {w.showReply && d.postSourceReply !== false && (
            <XPost
              id="part-reply"
              reply
              text={w.reply}
              name={d.xDisplayName}
              handle={d.xHandle}
              limit="single"
              placeholder="Sources: Psalm 51 (BSB) · Matthew Henry on Psalm 51:10"
              tag="Sources reply"
              readOnly={locked}
              onChange={w.setReplyText}
              onRemove={locked ? undefined : w.removeReply}
            />
          )}
        </div>
      ) : (
        <div className={`page-sheet ${w.busy === "draft" ? "dim" : ""}`}>
          <span className="page-kicker">{formatLabel(w.format)} · {d.study.display_ref}</span>
          <MarkEditor
            id="part-0"
            aria-label={`${formatLabel(w.format)} text`}
            spellCheck
            rows={12}
            value={w.parts[0] ?? ""}
            placeholder={PLACEHOLDER[w.format] ?? "Write…"}
            autoFocus={w.writingOwn && !w.hasText}
            readOnly={busy}
            onChange={(e) => w.setPart(0, e.target.value)}
          />
        </div>
      )}

      {!w.published && w.xFormat && (
        <div className="post-tools">
          {w.format === "thread" && w.parts.length < 4 && (
            <button className="btn sm ghost" disabled={busy} onClick={w.addPart}><Plus className="lucide" /> Add to thread</button>
          )}
          {w.format === "single" && countPost(w.parts[0] ?? "").over && (
            <button className="btn sm secondary" onClick={() => void w.splitThread()} disabled={busy}>Split into a thread</button>
          )}
          {!w.showReply && d.postSourceReply !== false && w.hasText && (
            <button className="btn sm ghost" disabled={busy} onClick={w.openReply}><Plus className="lucide" /> Sources reply</button>
          )}
        </div>
      )}

      {w.xFormat && !w.published && <VoiceNote studyId={d.study.id} />}

      {w.hasText && !w.published && <RefineBar disabled={busy} busy={w.busy === "sharpen"} onRefine={(mode, instruction) => void w.refine(mode, instruction)} />}

      {w.sharpened && !w.published && (
        <SharpenPanel key={w.sharpened.base_hash + JSON.stringify(w.sharpened.parts)} result={w.sharpened} multiPart={w.parts.length > 1} prose={!w.xFormat} disabled={busy} onApply={w.applySharpened} onClose={() => w.setSharpened(null)} />
      )}

      {w.alternate && (
        <section className="alt rise" aria-label="Another draft">
          <h3>Another draft from your notebook</h3>
          {w.alternate.parts.map((p: string, i: number) => <div key={i} className={`alt-text ${w.xFormat ? "x" : ""}`}>{p}</div>)}
          <div className="row">
            <button className="btn sm primary" disabled={busy} onClick={() => void w.useAlternate()}>Use this draft</button>
            <button className="btn sm ghost" onClick={() => w.setAlternate(null)}>Keep mine</button>
          </div>
        </section>
      )}

      {w.fromLastDraft && w.hasText && !w.published && !w.sharpened && (
        <section className="about">
          <button className="about-toggle" onClick={() => setAboutOpen((x) => !x)} aria-expanded={aboutOpen}>
            <span>About this draft</span>
            <span className="about-sum">{aboutSummary(d.lastDraft)}</span>
            <ChevronDown className="lucide" style={{ transform: aboutOpen ? "rotate(180deg)" : undefined }} />
          </button>
          {aboutOpen && <DraftNotes draft={d.lastDraft} disabled={busy} onEvidence={onEvidence} onOpening={w.useOpening} />}
        </section>
      )}

      {w.meaningChanges.length > 0 && w.hasText && (
        <div className="meaning">
          {w.meaningChanges.map((c: any, i: number) => (
            <div key={i} className="meaning-item">
              <div>The draft changed what you said: <del>{c.before}</del> → <ins>{c.after}</ins></div>
              {c.reason && <div className="why">{c.reason}</div>}
            </div>
          ))}
        </div>
      )}

      {w.compare && (
        <section className="compare rise" aria-label="Changes from your notebook">
          <div className="compare-head">
            <h3>Your notebook → this piece</h3>
            <button className="icon-btn sm" onClick={() => w.setCompare(false)} aria-label="Hide the comparison"><X className="lucide" /></button>
          </div>
          <div className="compare-text">{w.diff.map(([op, t], i) => (op === 0 ? <span key={i}>{t}</span> : op === 1 ? <ins key={i}>{t}</ins> : <del key={i}>{t}</del>))}</div>
        </section>
      )}
    </div>
  );
}

function aboutSummary(draft: any) {
  const bits = [
    draft.drew_on?.length ? `drew on ${draft.drew_on.length}` : null,
    draft.alternate_openings?.length ? `${draft.alternate_openings.length} other first line${draft.alternate_openings.length === 1 ? "" : "s"}` : null,
    draft.left_out?.length ? `${draft.left_out.length} left out` : null,
  ].filter(Boolean);
  return bits.join(" · ");
}

// ---------------- The check ----------------

function CheckPanel({ d, w }: { d: any; w: Writing }) {
  const reviewed = !!d.review;
  const qualification = [...d.runs].reverse().find((r: any) => r.qualification)?.qualification;
  const status = !w.hasText
    ? "Nothing to check yet."
    : w.checked
      ? w.openBlockers + w.openJudgments === 0 ? "Checked. Nothing needs your attention." : "Checked. A few things need you."
      : w.stale && reviewed
        ? "This version hasn't been checked yet."
        : "Not checked yet.";
  return (
    <div className="check-panel">
      <p className="check-head">
        <ShieldCheck className="lucide" aria-hidden="true" />
        <span>Checks every quotation against its source, every Scripture reference against the {d.passage?.translation ?? "BSB"}, and how a reader will hear it.</span>
      </p>
      <div className={`check-status ${w.checked && w.openBlockers + w.openJudgments === 0 ? "ok" : ""}`}>
        <span>{status}</span>
        {w.hasText && !w.published && (
          <button className={`btn sm ${w.checked ? "ghost" : "secondary"}`} onClick={() => void w.check()} disabled={!!w.busy}>
            {w.busy === "check" ? <Dots label="Checking" /> : w.checked ? "Check again" : "Check now"}
          </button>
        )}
      </div>
      {w.xFormat && w.hasText && !w.gate?.canPublish && w.checked && (w.gate?.reasons ?? []).length > 0 && (
        <ul className="gate-reasons">{w.gate.reasons.map((r: string, i: number) => <li key={i}>{r}</li>)}</ul>
      )}
      {w.hasText && w.checked && d.review?.first_line_reading && (
        <section className="reading-note">
          <h3>{w.xFormat ? "How a stranger reads it" : "How it reads"}</h3>
          <p>{d.review.first_line_reading}</p>
          {d.review.overall && <p className="muted">{d.review.overall}</p>}
        </section>
      )}
      {w.hasText && !w.published && <Findings findings={w.allFindings} stale={w.stale} onRepair={w.repair} onDecide={w.decide} multiPart={w.parts.length > 1} />}
      {w.hasText && !w.published && w.allFindings.length === 0 && !w.checked && <p className="check-empty">Quotations and references are checked as you write. A full check also reads for meaning and tone.</p>}
      {qualification && (
        <section className="reading-note caution">
          <h3>Keep in mind</h3>
          <p>{qualification}</p>
        </section>
      )}
    </div>
  );
}

// ---------------- A post as it will appear on X, editable in place ----------------

function Ring({ text, limit }: { text: string; limit: "single" | "long" }) {
  const c = countPost(text, limit);
  const r = 8;
  const circ = 2 * Math.PI * r;
  const frac = Math.min(1, c.weightedLength / c.limit);
  const left = c.limit - c.weightedLength;
  const cls = c.over ? "over" : left <= 20 ? "near" : "";
  return (
    <span className={`ring ${cls}`} aria-label={`${c.weightedLength} of ${c.limit} characters`} title={`${c.weightedLength} of ${c.limit}`}>
      {left <= 20 && <span>{left}</span>}
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <circle className="track" cx="10" cy="10" r={r} />
        <circle className="fill" cx="10" cy="10" r={r} strokeDasharray={circ} strokeDashoffset={circ * (1 - frac)} />
      </svg>
    </span>
  );
}

export function XPost({ id, text, name, handle, limit, placeholder, tag, reply, autoFocus, readOnly, onChange, onRemove }: { id: string; text: string; name: string; handle: string; limit: "single" | "long"; placeholder?: string; tag?: string; reply?: boolean; autoFocus?: boolean; readOnly?: boolean; onChange: (v: string) => void; onRemove?: () => void }) {
  return (
    <div className={`xpost ${reply ? "reply" : ""}`}>
      <span className="rail" aria-hidden="true" />
      <img className="avatar" src="/mark.svg" alt="" aria-hidden="true" />
      <div style={{ minWidth: 0 }}>
        <div className="xpost-name">
          {name || "Personal Commentary"} <span>@{handle || "yourhandle"}</span>
        </div>
        <AutoGrow id={id} aria-label={tag ?? "Post text"} spellCheck minRows={2} value={text} placeholder={placeholder} autoFocus={autoFocus} readOnly={readOnly} onChange={(e) => onChange(e.target.value)} />
        <div className="xpost-foot">
          {tag && <span className="tag">{tag}</span>}
          {onRemove && (
            <button className="icon-btn sm" aria-label={`Remove ${tag ?? "this part"}`} title="Remove" onClick={onRemove}>
              <X className="lucide" />
            </button>
          )}
          {!readOnly && <Ring text={text} limit={limit} />}
        </div>
      </div>
    </div>
  );
}
