// A study's own text fields (title, notes): serialized autosaves, a visible state in the
// study header, and a flush before anything reads them (research, drafting, leaving the stage, quitting the app).
import { useEffect, useRef, useState } from "react";
import { api, queryClient } from "../api";
import { useToast } from "../components/ui";
import { createAutosaveQueue } from "../autosave";
import { onBeforeQuit } from "../desktop";
import { reportSave, type SaveState } from "../saveStatus";

export type StudyField = "first_observation" | "note" | "title";
const NAME: Record<StudyField, string> = { first_observation: "notes", note: "notes", title: "title" };

export function useStudyField(studyId: string, field: StudyField) {
  const toast = useToast();
  const [state, setState] = useState<SaveState>("saved");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queue = useRef<ReturnType<typeof createAutosaveQueue<Record<string, string | null>>> | null>(null);
  if (!queue.current)
    queue.current = createAutosaveQueue(async (patch) => {
      setState("saving");
      try {
        await api(`/api/studies/${studyId}`, { method: "PATCH", body: patch });
        setState("saved");
        queryClient.invalidateQueries({ queryKey: ["studies"] });
        return true;
      } catch (e: any) {
        setState("failed");
        toast(`Your ${NAME[field]} didn't save: ${e.message} Your words are still here. Press ⌘S to try again.`, "error");
        return false;
      }
    });
  const flush = () => {
    if (timer.current) clearTimeout(timer.current);
    return queue.current!.flush();
  };
  useEffect(() => {
    const off = onBeforeQuit(flush, () => queue.current!.hasPending());
    return () => {
      off();
      void flush();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => reportSave(`${studyId}:${field}`, state), [state, studyId, field]);
  useEffect(() => () => reportSave(`${studyId}:${field}`, null), [studyId, field]);
  const change = (value: string) => {
    // Other parts of the study (the word count, drafting, the header) read the cached copy, so keep it current as you type.
    queryClient.setQueryData(["study", studyId], (old: any) => (old ? { ...old, study: { ...old.study, [field]: value } } : old));
    queue.current!.add({ [field]: field === "note" ? value : value || null });
    setState("pending");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void queue.current!.flush(), 600);
  };
  return { change, flush, state };
}
