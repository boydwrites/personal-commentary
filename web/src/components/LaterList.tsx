// Saved for later: ideas, questions, and findings set aside to study another day. "Study this" starts a study from one.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Lightbulb } from "lucide-react";
import { api, navigate, queryClient, relDate } from "../api";
import { Link, Empty, useToast, Menu } from "./ui";

export function useLater() {
  return useQuery({ queryKey: ["later"], queryFn: () => api<any[]>("/api/later") });
}

export function LaterList({ limit, capture = true }: { limit?: number; capture?: boolean }) {
  const toast = useToast();
  const list = useLater();
  const [text, setText] = useState("");
  const [askRef, setAskRef] = useState<string | null>(null);
  const [refText, setRefText] = useState("");
  const reload = () => queryClient.invalidateQueries({ queryKey: ["later"] });
  // A line ending in "?" is a question; anything else is an idea.
  const kind = text.trim().endsWith("?") ? "question" : "idea";
  const items = (list.data ?? []).filter((it) => !it.used_in_study_id).concat((list.data ?? []).filter((it) => it.used_in_study_id));
  const shown = limit ? items.slice(0, limit) : items;

  const startFrom = async (item: any, ref?: string) => {
    const r0 = ref ?? item.primary_ref;
    if (!r0) {
      setAskRef(item.id);
      setRefText("");
      return;
    }
    try {
      const r = await api("/api/studies", { method: "POST", body: { ref: r0, origin: "later", laterItemId: item.id, question: item.kind === "question" ? item.text : null, parentStudyId: item.study_id ?? null } });
      queryClient.invalidateQueries({ queryKey: ["studies"] });
      reload();
      navigate(`/study/${r.id}`);
    } catch (e: any) {
      toast(e.message, "error");
    }
  };
  const remove = async (it: any) => {
    try {
      await api(`/api/later/${it.id}`, { method: "DELETE" });
      reload();
    } catch (e: any) {
      toast(e.message, "error");
    }
  };

  return (
    <div className="later">
      {capture && (
        <form
          className="capture"
          onSubmit={async (e) => {
            e.preventDefault();
            const t = text.trim();
            if (!t) return;
            setText(""); // clear at once so the next thought can start immediately
            try {
              await api("/api/later", { method: "POST", body: { kind, text: t } });
              reload();
            } catch (er: any) {
              setText(t);
              toast(`That didn't save: ${er.message} Your words are back in the box; try again.`, "error");
            }
          }}
        >
          <Lightbulb className="lucide" aria-hidden="true" />
          <input placeholder="An idea or a question to study another day…" value={text} onChange={(e) => setText(e.target.value)} aria-label="Save an idea or a question for later" />
          <button className="btn sm primary" type="submit" disabled={!text.trim()}>Save {text.trim() ? kind : ""}</button>
        </form>
      )}

      {list.isSuccess && items.length === 0 && !limit && (
        <Empty title="Nothing saved for later.">Set aside a finding from its ⋯ menu in the research, or write an idea or question above.</Empty>
      )}
      {shown.map((it: any) => (
        <div key={it.id} className={`later-item is-${it.kind} ${it.used_in_study_id ? "used" : ""}`}>
          <div className="later-meta">
            <span className="later-kind">{it.kind === "card" ? (it.author_name ?? "Finding") : it.kind === "question" ? "Question" : "Idea"}</span>
            {it.display_ref && (
              <span>from <Link className="link" to={`/study/${it.study_id}`}>{it.display_ref}</Link></span>
            )}
            <span>{relDate(it.created_at)}</span>
            {it.used_in_study_id && <Link className="link" to={`/study/${it.used_in_study_id}`}>Studied</Link>}
            <span className="spacer" />
            <Menu label="More" items={[{ label: "Remove", danger: true, onSelect: () => void remove(it) }]} />
          </div>
          {it.card_title && <div className="later-title">{it.card_title}</div>}
          <div className="later-body">{it.card_body ?? it.text}</div>
          {askRef === it.id ? (
            <form className="ref-prompt" onSubmit={(e) => { e.preventDefault(); if (refText.trim()) void startFrom(it, refText.trim()); }}>
              <input className="input" autoFocus placeholder="Which passage? For example, Psalm 23" value={refText} onChange={(e) => setRefText(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setAskRef(null)} />
              <button className="btn sm primary" type="submit" disabled={!refText.trim()}>Begin</button>
            </form>
          ) : !it.used_in_study_id && (
            <button className="btn sm ghost later-go" onClick={() => void startFrom(it)}>Study this <ArrowRight className="lucide" /></button>
          )}
        </div>
      ))}
    </div>
  );
}
