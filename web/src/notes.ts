// Highlighting a line from anywhere in a study: the passage, a finding, a source, a question.
// The notebook's open editor takes the line at your cursor; when no editor is on screen, the line is added to your
// notes on the server.
import { api, queryClient } from "./api";

/** A highlighted line from Scripture or the research. ">" marks it as not your own words, so it never counts toward drafting (R1). */
export type Keep = { text: string; cite?: string | null };
export type KeepRequest = Keep & { blocked?: boolean };

export function keptLines(k: Keep): string {
  const text = k.text.replace(/\s+/g, " ").trim();
  return `> ${text}${k.cite ? ` — ${k.cite}` : ""}`;
}

export const ADD_EVENT = "commentary:add-to-note";

/** Returns how the line landed: "editor" (inserted at the cursor) or "saved" (added to your notes on the server). */
export async function addToNote(studyId: string, k: Keep): Promise<"editor" | "saved"> {
  const detail: KeepRequest = { ...k };
  const ev = new CustomEvent(ADD_EVENT, { detail, cancelable: true });
  window.dispatchEvent(ev);
  if (detail.blocked) throw new Error("That line wasn't added while your notebook was busy. Your notes are saved; try again in a moment.");
  if (ev.defaultPrevented) return "editor";
  const cur: any = queryClient.getQueryData(["study", studyId]);
  const note: string = cur?.study?.note ?? "";
  const next = `${note.trimEnd()}${note.trim() ? "\n\n" : ""}${keptLines(k)}\n`;
  await api(`/api/studies/${studyId}`, { method: "PATCH", body: { note: next } });
  queryClient.setQueryData(["study", studyId], (old: any) => (old ? { ...old, study: { ...old.study, note: next } } : old));
  return "saved";
}

export { ownWordCount as ownWords } from "../../shared/text.ts";
