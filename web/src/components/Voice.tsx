// Your voice on X. A draft for X learns how you write from the posts you've written in your studies (the ones you
// rewrote or posted; a draft you kept word for word is the app's voice, not yours) and from posts you like.
// Style only, never content.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Feather, Plus, X } from "lucide-react";
import { api, queryClient } from "../api";
import { Dots, Modal, useToast } from "./ui";

type Voice = { own: { ref: string; text: string; posted: boolean }[]; liked: string[] };

function useVoice(studyId?: string) {
  return useQuery<Voice>({ queryKey: ["voice", studyId ?? null], queryFn: () => api(`/api/voice${studyId ? `?except=${encodeURIComponent(studyId)}` : ""}`) });
}

function count(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

/** The posts your X drafts learn from, and the ones you like (add or remove them here). */
export function VoiceLibrary({ studyId }: { studyId?: string }) {
  const toast = useToast();
  const q = useVoice(studyId);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const liked = q.data?.liked ?? [];
  const save = async (next: string[], done: string) => {
    setSaving(true);
    try {
      await api("/api/preferences", { method: "PUT", body: { approvedExamples: next } });
      await queryClient.invalidateQueries({ queryKey: ["voice"] });
      queryClient.invalidateQueries({ queryKey: ["prefs"] });
      toast(done);
      return true;
    } catch (e: any) {
      toast(`That didn't save: ${e.message} Your posts are unchanged; try again.`, "error");
      return false;
    } finally {
      setSaving(false);
    }
  };
  const add = async () => {
    const text = draft.trim();
    if (!text) return;
    if (await save([text, ...liked.filter((x) => x !== text)], "Added. Your next X draft will learn from it.")) setDraft("");
  };
  if (q.isLoading) return <Dots label="Loading your posts" />;
  if (q.isError) return <p className="muted">Your posts didn't load. <button className="text-btn" onClick={() => void q.refetch()}>Try again</button></p>;
  return (
    <div className="voice">
      <section>
        <h3>Posts you wrote <span>{q.data!.own.length ? "from your studies" : ""}</span></h3>
        {q.data!.own.length ? (
          <ul className="voice-list">
            {q.data!.own.map((p, i) => (
              <li key={i}>
                <span className="voice-ref">{p.ref}{p.posted ? " · posted" : ""}</span>
                <p>{p.text}</p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="voice-empty">Posts you write or rewrite for X in a study show up here.</p>
        )}
      </section>
      <section>
        <h3>Posts you like <span>yours from X, or anyone's</span></h3>
        <div className="voice-add">
          <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={3} placeholder="Paste a post…" aria-label="A post you like" />
          <button className="btn sm secondary" onClick={() => void add()} disabled={saving || !draft.trim()}><Plus className="lucide" /> Add</button>
        </div>
        {liked.length > 0 && (
          <ul className="voice-list">
            {liked.map((t, i) => (
              <li key={i}>
                <p>{t}</p>
                <button className="icon-btn sm" aria-label="Remove this post" title="Remove" disabled={saving}
                  onClick={() => void save(liked.filter((_, j) => j !== i), "Removed.")}>
                  <X className="lucide" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/** Under an X post: what its drafts learn your voice from, and a way to add more. */
export function VoiceNote({ studyId }: { studyId: string }) {
  const q = useVoice(studyId);
  const [open, setOpen] = useState(false);
  if (!q.data) return null;
  const own = q.data.own.length;
  const liked = q.data.liked.length;
  const from = [own ? count(own, "of your posts", "of your posts") : null, liked ? count(liked, "you like", "you like") : null].filter(Boolean);
  return (
    <>
      <button className="voice-note" onClick={() => setOpen(true)}>
        <Feather className="lucide" aria-hidden="true" />
        {from.length ? <span>In your voice, from {from.join(" and ")}</span> : <span>Teach it your voice</span>}
        <span className="voice-note-act">{from.length ? "See or add" : "Add posts you like"}</span>
      </button>
      <Modal open={open} onClose={() => setOpen(false)} label="Your voice on X" wide>
        <h2>Your voice on X</h2>
        <p className="muted voice-lede">X drafts follow the way you write: how long you run, how you open, how you land. They learn the style, never the content.</p>
        <VoiceLibrary studyId={studyId} />
      </Modal>
    </>
  );
}
