import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { Modal, Dots } from "./ui";
import type { WritingFormat } from "../../../shared/writing.ts";

type PostVersion = { id: string; format: WritingFormat; parts: string[]; source_reply: string; text_hash: string; cause: string; created_at: string };
type NoteVersion = { id: string; note: string; created_at: string };

const CAUSE: Record<string, string> = {
  typing: "Your edits", draft_applied: "First draft", repair_applied: "Check suggestion", split: "Split into a thread", format_changed: "Opened this piece", before_change: "Before a change", restore: "Restored", undo: "Undo", sharpen: "Refined",
};

function when(iso: string) {
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  return today
    ? d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** Earlier versions of the piece or of your notes, newest first. Pick one to read it in full, then restore it. */
export function History({
  studyId, format, currentHash, currentNote, canRestorePost, onClose, onRestorePost, onRestoreNote, only,
}: {
  /** Show only the piece's versions or only the notes'. */
  only?: "post" | "note";
  studyId: string;
  format: WritingFormat;
  currentHash: string | null;
  currentNote: string;
  canRestorePost: boolean;
  onClose: () => void;
  onRestorePost: (v: PostVersion) => void;
  onRestoreNote: (text: string) => void;
}) {
  const q = useQuery({ queryKey: ["history", studyId, format], queryFn: () => api<{ post: PostVersion[]; note: NoteVersion[] }>(`/api/studies/${studyId}/history?format=${format}`), staleTime: 0 });
  const [tab, setTab] = useState<"post" | "note">(only ?? "post");
  const [picked, setPicked] = useState<string | null>(null);
  const post = q.data?.post ?? [];
  const note = q.data?.note ?? [];
  const list = tab === "post" ? post : note;
  const sel = list.find((v) => v.id === picked) ?? list[0];
  const isCurrent = (v: any) => (tab === "post" ? v.text_hash === currentHash : v.note === currentNote);

  return (
    <Modal open onClose={onClose} label="Earlier versions" wide>
      <h2>{only === "note" ? "Earlier notes" : only === "post" ? "Earlier versions of this piece" : "Earlier versions"}</h2>
      {!only && (
        <div className="row" style={{ marginBottom: 14 }}>
          <div className="seg" role="group" aria-label="Which text">
            <button aria-pressed={tab === "post"} onClick={() => { setTab("post"); setPicked(null); }}>Piece · {post.length}</button>
            <button aria-pressed={tab === "note"} onClick={() => { setTab("note"); setPicked(null); }}>Notes · {note.length}</button>
          </div>
        </div>
      )}
      {q.isLoading && <Dots label="Loading" />}
      {q.isError && <p className="muted">Earlier versions couldn't load. Your current writing is safe. <button className="text-btn" onClick={() => void q.refetch()}>Try again</button></p>}
      {!q.isLoading && !q.isError && list.length === 0 && <p className="muted">{tab === "post" ? "No versions of this piece yet. They appear here as you draft and edit." : "No earlier notes yet."}</p>}
      {list.length > 0 && sel && (
        <div className="history">
          <ul className="history-list" aria-label="Versions">
            {list.map((v: any) => (
              <li key={v.id}>
                <button aria-pressed={v.id === sel.id} onClick={() => setPicked(v.id)}>
                  <span className="history-when">{when(v.created_at)}</span>
                  <span className="history-what">{isCurrent(v) ? "Current" : tab === "post" ? CAUSE[v.cause] ?? v.cause : `${(v.note.match(/[\p{L}\p{N}’'-]+/gu) ?? []).length} words`}</span>
                </button>
              </li>
            ))}
          </ul>
          <div className="history-view">
            <div className="history-text">
              {tab === "post"
                ? (sel as PostVersion).parts.filter((p) => p.trim()).map((p, i, a) => (
                    <p key={i}>{a.length > 1 && <span className="faint">{i + 1}/{a.length} </span>}{p}</p>
                  ))
                : (sel as NoteVersion).note.split(/\n{2,}/).map((p, i) => <p key={i}>{p}</p>)}
              {tab === "post" && (sel as PostVersion).source_reply?.trim() && <p className="faint">{(sel as PostVersion).source_reply}</p>}
            </div>
            <div className="row" style={{ justifyContent: "flex-end" }}>
              {isCurrent(sel) ? (
                <span className="small muted">This is what you have now.</span>
              ) : tab === "post" && !canRestorePost ? (
                <span className="small muted">This piece is posted on X, so its text can't change.</span>
              ) : (
                <button className="btn primary sm" onClick={() => (tab === "post" ? onRestorePost(sel as PostVersion) : onRestoreNote((sel as NoteVersion).note))}>
                  Restore this version
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
