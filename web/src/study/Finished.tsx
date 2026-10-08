// A finished study, read like a page: the passage, what you made from it, your notes as you wrote them, what you
// highlighted, and the research behind it all (folded away until you want it).
// Finishing marks the study done and writes a readable Markdown file; everything stays editable.
import { useState } from "react";
import { ArrowUpRight, ChevronDown, Copy, FileText, Pencil, Plus, Send, X } from "lucide-react";
import { api, fmtDate, navigate, queryClient } from "../api";
import { useToast } from "../components/ui";
import { Mark } from "../components/Logo";
import { Passage } from "../components/Passage";
import { Markdown, splitCite } from "../components/Markdown";
import { SECTION_LABEL, StudyBrief, briefCardsOf, sectionOf } from "../components/Brief";
import { ownWords } from "../notes";
import { isXFormat, type WritingFormat } from "../../../shared/writing.ts";
import { HeaderAction } from "./StudyHeader";
import { Provenance } from "./ResearchStage";
import { PIECES, formatLabel, inSentence, pieceOf } from "./pieces";
import { TitleEditor } from "./TitleEditor";
import { openChooserNext } from "./WriteStage";

let justFinished: { id: string; where: string } | null = null;
/** The next time this study's finished page opens, it says where the file went. */
export function markJustFinished(id: string, where: string) {
  justFinished = { id, where };
}

export function reveal(id: string, toast: ReturnType<typeof useToast>) {
  api(`/api/studies/${id}/reveal`, { method: "POST" }).catch((e) => toast(e.message, "error"));
}

/** Reading order: the post first (the idea in brief), then the longer pieces. */
const ORDER: WritingFormat[] = ["single", "long", "thread", "notes", "journal", "devotional"];
type Shown = { text: string; url: string | null; reply: boolean };
type FinishedPiece = { format: WritingFormat; parts: string[]; posts: Shown[] | null };

export function Finished({ d, refresh, onEvidence }: { d: any; refresh: () => void; onEvidence: (id: string) => void }) {
  const toast = useToast();
  const s = d.study;
  const [banner, setBanner] = useState(() => {
    const j = justFinished?.id === s.id ? justFinished : null;
    justFinished = null;
    return j;
  });
  const [showResearch, setShowResearch] = useState(false);
  const posted = (d.publish?.posts ?? []).filter((p: any) => p.status === "posted");
  const { current, base } = briefCardsOf(d);
  const highlighted = d.cards.filter((c: any) => c.selected);
  const firstUrl = posted[0]?.x_url;

  // Every piece with words in it, in reading order. Once posted, the X post is what went out.
  const pieces: FinishedPiece[] = [];
  if (posted.length) pieces.push({ format: "single", parts: posted.filter((p: any) => p.role !== "source_reply").map((p: any) => p.published_text ?? p.text), posts: posted.map((p: any) => ({ text: p.published_text ?? p.text, url: p.x_url, reply: p.role === "source_reply" })) });
  for (const v of d.pieces ?? []) {
    const parts = (v.parts as string[]).filter((p) => p.trim());
    if (!parts.length || (posted.length && isXFormat(v.format))) continue;
    pieces.push({ format: v.format, parts, posts: isXFormat(v.format) ? [...parts.map((t) => ({ text: t, url: null, reply: false })), ...(v.source_reply?.trim() ? [{ text: v.source_reply, url: null, reply: true }] : [])] : null });
  }
  pieces.sort((a, b) => ORDER.indexOf(a.format) - ORDER.indexOf(b.format));

  const notes: string = s.note ?? "";
  const hasStudyNotes = pieces.some((p) => p.format === "notes");
  // When study notes organize your notebook, your notes as you wrote them fold away under them.
  const [notesOpen, setNotesOpen] = useState(!hasStudyNotes);
  const editStage = pieces.length ? "write" : d.runs.length ? "research" : "read";
  const made = new Set(pieces.map((p) => pieceOf(p.format).kind));
  const notYet = PIECES.filter((p) => !made.has(p.kind)).map((p) => `${p.kind === "x" ? "an" : "a"} ${inSentence(p.label)}`);
  const firstPiece = pieces[0];

  /** Back to Write, on the choice of piece: the new one builds on what's here. */
  const anotherPiece = () => {
    openChooserNext(s.id);
    void navigate(`/study/${s.id}/write`);
  };
  /** Back to Write, on this piece. */
  const editPiece = async (format: WritingFormat) => {
    try {
      await api(`/api/studies/${s.id}/writing-format`, { method: "POST", body: { format } });
      await queryClient.invalidateQueries({ queryKey: ["study", s.id] });
      void navigate(`/study/${s.id}/write`);
    } catch (e: any) {
      toast(e.message, "error");
    }
  };
  const copy = async (piece: FinishedPiece) => {
    try {
      await navigator.clipboard.writeText(piece.parts.join("\n\n"));
      toast(`${formatLabel(piece.format)} copied.`);
    } catch {
      toast("The clipboard wasn't available. Select the text and press ⌘C to copy it.", "error");
    }
  };

  const toc = [
    ...pieces.map((p) => ({ id: `fin-piece-${p.format}`, label: posted.length && isXFormat(p.format) ? "Posted to X" : formatLabel(p.format) })),
    ...(notes.trim() ? [{ id: "fin-your-notes", label: "Your notes" }] : []),
    ...(highlighted.length ? [{ id: "fin-highlights", label: "Highlighted" }] : []),
    ...(d.cards.length ? [{ id: "fin-research", label: "Research" }] : []),
  ];
  const jump = (id: string) => {
    if (id === "fin-your-notes") setNotesOpen(true);
    if (id === "fin-research") setShowResearch(true);
    setTimeout(() => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" }), 30);
  };

  return (
    <article className="finished">
      <HeaderAction>
        {firstUrl ? (
          <a className="btn x" href={firstUrl} target="_blank" rel="noreferrer noopener">View on X <ArrowUpRight className="lucide" /></a>
        ) : (
          <button className="btn secondary" onClick={() => void navigate(`/study/${s.id}/${editStage}`)}><Pencil className="lucide" /> Edit</button>
        )}
      </HeaderAction>

      {banner && (
        <section className="done-banner rise" aria-live="polite">
          <Mark size={56} />
          <div className="done-banner-text">
            <h2>Kept.</h2>
            <p>{s.display_ref} is finished and saved to {banner.where}.</p>
          </div>
          <div className="done-banner-actions">
            {pieces.length > 0 && !made.has("x") && <button className="btn sm primary" onClick={anotherPiece}><Send className="lucide" /> Make an X post from it</button>}
            {firstPiece && <button className="btn sm secondary" onClick={() => void copy(firstPiece)}><Copy className="lucide" /> Copy {inSentence(formatLabel(firstPiece.format))}</button>}
            {s.record_path && <button className="btn sm ghost" onClick={() => reveal(s.id, toast)}><FileText className="lucide" /> Show in Finder</button>}
          </div>
          <button className="icon-btn sm done-banner-close" onClick={() => setBanner(null)} aria-label="Dismiss"><X className="lucide" /></button>
        </section>
      )}

      <header className="fin-head">
        <h1 className="fin-ref">{s.display_ref}</h1>
        <TitleEditor study={s} triggerClassName={`fin-title ${s.title ? "" : "untitled"}`} trigger={s.title ?? "Name this study"} />
        <p className="fin-meta">
          <span className={`status-chip ${s.status}`}>{s.status === "published" ? "Posted" : s.status === "archived" ? "Archived" : "Finished"}</span>
          <span>Studied {fmtDate(s.created_local_date)}</span>
          {s.saved_at && fmtDate(s.saved_at) !== fmtDate(s.created_local_date) && <span>· finished {fmtDate(s.saved_at)}</span>}
        </p>
      </header>

      {d.passage && (
        <blockquote className="fin-passage">
          <Passage passage={d.passage} showChapter={false} cite={`${s.display_ref} (${d.passage.translation})`} />
          <footer>{d.passage.translation}</footer>
        </blockquote>
      )}
      {s.question && <p className="fin-question">{s.question}</p>}

      {toc.length > 2 && (
        <nav className="fin-toc" aria-label="On this page">
          {toc.map((t) => <button key={t.id} onClick={() => jump(t.id)}>{t.label}</button>)}
        </nav>
      )}

      {pieces.length === 0 ? (
        <div className="fin-empty">
          <p>Nothing written from this study yet.</p>
          <button className="btn secondary" onClick={() => void navigate(`/study/${s.id}/write`)}>Write a piece</button>
        </div>
      ) : (
        pieces.map((piece) => {
          const x = isXFormat(piece.format);
          const isPosted = x && piece.posts?.some((p) => p.url);
          const Icon = pieceOf(piece.format).Icon;
          return (
            <section key={piece.format} id={`fin-piece-${piece.format}`} className="fin-sec fin-piece">
              <div className="fin-piece-head">
                <h2><Icon className="lucide" aria-hidden="true" /> {isPosted ? "Posted to X" : formatLabel(piece.format)}</h2>
                <span className="spacer" />
                {!isPosted && <button className="btn sm ghost" onClick={() => void editPiece(piece.format)}><Pencil className="lucide" /> Edit</button>}
                <button className="btn sm ghost" onClick={() => void copy(piece)}><Copy className="lucide" /> Copy</button>
              </div>
              {x ? <XThread d={d} posts={piece.posts ?? []} /> : <div className="fin-prose"><Markdown text={piece.parts.join("\n\n")} baseLevel={3} /></div>}
            </section>
          );
        })
      )}

      {pieces.length > 0 && (
        <div className="fin-another">
          <button className="btn secondary" onClick={anotherPiece}><Plus className="lucide" /> Make another piece</button>
          {notYet.length > 0 && <span className="muted small">{listOf(notYet)}, built on what you wrote here.</span>}
        </div>
      )}

      {notes.trim() && (
        <section id="fin-your-notes" className="fin-sec fin-notes">
          {hasStudyNotes ? (
            <button className="fin-fold" onClick={() => setNotesOpen((x) => !x)} aria-expanded={notesOpen}>
              <h2>Your notes, as you wrote them</h2>
              <span className="fin-fold-sum">{ownWords(notes)} words</span>
              <ChevronDown className="lucide" />
            </button>
          ) : (
            <h2>Your notes</h2>
          )}
          {notesOpen && <Markdown text={notes} className="fin-note rise" baseLevel={3} />}
        </section>
      )}

      {highlighted.length > 0 && (
        <section id="fin-highlights" className="fin-sec">
          <h2>Highlighted in the research</h2>
          <ul className="fin-highlights">
            {highlighted.map((c: any) => {
              const q = c.quotes?.[0];
              const cite = c.quote_cites?.[0] ?? c.author_name;
              return (
                <li key={c.id}>
                  <button onClick={() => onEvidence(c.id)} title="Open this finding and its sources">
                    <span className="fin-hl-kicker">{c.author_name ?? SECTION_LABEL[sectionOf(c)]}</span>
                    <span className="fin-hl-title">{c.title}</span>
                    {q && (
                      <span className="fin-hl-quote">
                        “{splitCite(q).text}”{cite && !c.author_name ? <span className="fin-hl-cite"> {cite}</span> : null}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {d.cards.length > 0 && (
        <section id="fin-research" className="fin-sec fin-research">
          <div className="fin-research-head">
            <button className="btn ghost" onClick={() => setShowResearch((x) => !x)} aria-expanded={showResearch}>
              {showResearch ? "Hide the research" : `The full research · ${current.length} findings`}
              <ChevronDown className="lucide" style={{ transform: showResearch ? "rotate(180deg)" : undefined }} />
            </button>
            <Provenance d={d} base={base} />
          </div>
          {showResearch && <StudyBrief d={d} cards={current} latestRunId={d.runs.at(-1)?.id ?? null} running={false} onEvidence={onEvidence} onChanged={refresh} />}
        </section>
      )}
    </article>
  );
}

/** "a journal entry, a devotional, or an X post" → capitalized for the start of a line. */
function listOf(items: string[]) {
  const text = items.length > 1 ? `${items.slice(0, -1).join(", ")}${items.length > 2 ? "," : ""} or ${items.at(-1)}` : items[0];
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Posts as they appear (or will appear) on X. */
function XThread({ d, posts }: { d: any; posts: Shown[] }) {
  const main = posts.filter((x) => !x.reply).length;
  return (
    <div className="thread">
      {posts.map((p, i) => (
        <div key={i} className={`xpost ${p.reply ? "reply" : ""}`}>
          <span className="rail" aria-hidden="true" />
          <img className="avatar" src="/mark.svg" alt="" aria-hidden="true" />
          <div style={{ minWidth: 0 }}>
            <div className="xpost-name">{d.xDisplayName || "Personal Commentary"} <span>@{d.xHandle || "yourhandle"}</span></div>
            <div className="xpost-text">{p.text}</div>
            <div className="xpost-foot">
              {(p.reply || main > 1) && <span className="tag">{p.reply ? "Sources reply" : `${i + 1}/${main}`}</span>}
              {p.url && <a className="btn sm ghost" href={p.url} target="_blank" rel="noreferrer noopener">View <ArrowUpRight className="lucide" /></a>}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
