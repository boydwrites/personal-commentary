// The writing desk's state: the piece's working text and its autosave, drafts, refinements, the check, and Undo.
// Ported from the earlier Writer so its guarantees hold: saves are serialized, a conflict never replaces local words,
// every model call waits for pending notes to land, and every replacement offers Undo.
import { useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, queryClient } from "../api";
import { useToast } from "../components/ui";
import type { FindingView } from "../components/Findings";
import type { SharpenResult, RefinementMode } from "../components/WritingTools";
import { wordDiff } from "../diff";
import { flushPendingChanges, onBeforeQuit } from "../desktop";
import { ownWords } from "../notes";
import { reportSave } from "../saveStatus";
import { isXFormat, type WritingFormat as Format } from "../../../shared/writing.ts";
import { formatLabel } from "./pieces";

export type Busy = null | "draft" | "alt" | "check" | "sharpen" | "format" | "finish";
export type TextSnapshot = { parts: string[]; reply: string; format: Format };

export function useWriting(d: any, refresh: () => void) {
  const toast = useToast();
  const s = d.study;
  const [sharpened, setSharpened] = useState<SharpenResult | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [format, setFormat] = useState<Format>((d.working?.format ?? s.format ?? "journal") as Format);
  const [parts, setParts] = useState<string[]>(d.working?.parts?.length ? d.working.parts : [""]);
  const [reply, setReply] = useState<string>(d.working?.source_reply ?? "");
  const [hash, setHash] = useState<string | null>(d.working?.text_hash ?? null);
  const [gate, setGate] = useState<any>(d.gate);
  const [findings, setFindings] = useState<{ deterministic: FindingView[]; model: FindingView[] }>(d.findings);
  const [compare, setCompare] = useState(false);
  const [showReply, setShowReply] = useState(!!d.working?.source_reply?.trim());
  const [alternate, setAlternate] = useState<any>(null);
  const [publishing, setPublishing] = useState(false);
  const [writingOwn, setWritingOwn] = useState(false);
  const [saving, setSaving] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [undo, setUndo] = useState<TextSnapshot | null>(null);
  const dirty = useRef(false);
  const formatRef = useRef(format);
  formatRef.current = format;
  const undoRef = useRef(undo);
  undoRef.current = undo;
  const busyRef = useRef(false);
  busyRef.current = !!busy;

  // Keep in step when the server copy changes (a draft applied elsewhere, a refresh).
  useEffect(() => {
    if (dirty.current) return;
    if (d.working && (d.working.text_hash !== hash || d.working.format !== format)) {
      setParts(d.working.parts.length ? d.working.parts : [""]);
      setReply(d.working.source_reply ?? "");
      setFormat(d.working.format);
      setHash(d.working.text_hash);
    }
    setGate(d.gate);
    setFindings(d.findings);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d.working?.text_hash, d.gate, d.findings]);

  useEffect(() => {
    reportSave("piece", saving === "error" ? "failed" : saving === "saving" ? "saving" : "saved");
  }, [saving]);
  useEffect(() => () => reportSave("piece", null), []);

  // ---- Autosave the working text; the server returns the deterministic findings and the gate. ----
  const textTimer = useRef<any>(null);
  const textWrite = useRef<Promise<unknown>>(Promise.resolve());
  const textVersion = useRef(0);
  const hashRef = useRef(hash);
  hashRef.current = hash;
  const cacheWorking = (r: any) => {
    queryClient.setQueryData(["study", s.id], (old: any) => old ? {
      ...old,
      study: { ...old.study, format: r.working.format },
      working: r.working,
      gate: r.gate,
      findings: r.findings,
      availableFormats: r.working.parts.some((p: string) => p.trim()) ? [...new Set([...(old.availableFormats ?? []), r.working.format])] : old.availableFormats,
    } : old);
    queryClient.invalidateQueries({ queryKey: ["history", s.id] });
  };
  const putText = (next: TextSnapshot, cause = "typing") => {
    const request = textWrite.current.catch(() => {}).then(() => api(`/api/studies/${s.id}/working-text`, { method: "PUT", body: { format: next.format, parts: next.parts, source_reply: next.reply, base_hash: hashRef.current, base_format: formatRef.current, cause } }));
    const result = request.then((r) => {
      setHash(r.working.text_hash);
      hashRef.current = r.working.text_hash;
      setGate(r.gate);
      setFindings(r.findings);
      cacheWorking(r);
      return r;
    });
    textWrite.current = result;
    return result;
  };
  const pendingText = useRef<(() => Promise<boolean>) | null>(null);
  const textInFlight = useRef<Promise<boolean> | null>(null);
  const saveText = (next: TextSnapshot, cause = "typing", immediate = false) => {
    dirty.current = true;
    setSaving("saving");
    const version = ++textVersion.current;
    setGate((current: any) => ({ ...current, canPublish: false, modelReview: "stale" }));
    clearTimeout(textTimer.current);
    const go = async () => {
      if (pendingText.current === go) pendingText.current = null;
      setSaving("saving");
      try {
        await putText(next, cause);
        if (version === textVersion.current) {
          dirty.current = false;
          setSaving("saved");
        }
        return true;
      } catch (e) {
        setSaving("error");
        if (version === textVersion.current) pendingText.current = go;
        if (e instanceof ApiError && e.status === 409) {
          // Keep the local text visible and pending; never replace unsaved writing on a conflict.
          toast("This piece changed in another window. Your words are still here. Copy them before reopening this study to compare the saved version.", "error");
        } else {
          toast(`Your piece didn't save: ${(e as Error).message} Your text is still here. Keep this study open; it will try again when you press ⌘S.`, "error");
        }
        return false;
      }
    };
    pendingText.current = go;
    if (immediate) textInFlight.current = go();
    else textTimer.current = setTimeout(() => { textInFlight.current = go(); }, 350);
  };
  const flushText = async () => {
    clearTimeout(textTimer.current);
    if (textInFlight.current) {
      const request = textInFlight.current;
      const ok = await request;
      if (textInFlight.current === request) textInFlight.current = null;
      if (!ok && !pendingText.current) return false;
    }
    if (pendingText.current) {
      textInFlight.current = pendingText.current();
      return textInFlight.current;
    }
    return !dirty.current;
  };
  // Leaving the stage, quitting the Mac app, or calling the model sends whatever is still waiting on a timer.
  useEffect(() => {
    const off = onBeforeQuit(flushText, () => dirty.current);
    return () => {
      off();
      void flushText();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- Derived state ----
  const noteWords = ownWords(s.note ?? "");
  // Notes are optional: a draft can stand on your notes, your other pieces, or the research alone.
  const canDraft = noteWords > 0 || d.cards.length > 0 || (d.availableFormats?.length ?? 0) > 0;
  const hasText = parts.some((p) => p.trim());
  const xFormat = isXFormat(format);
  const published = xFormat && !!d.publish?.done && !d.publish?.stale;
  const partlyPosted = xFormat && !published && !d.publish?.stale && d.publish?.posts?.some((p: any) => p.status === "posted");
  const allFindings = useMemo(() => [...(findings?.deterministic ?? []), ...(findings?.model ?? [])], [findings]);
  const checked = !dirty.current && gate?.modelReview === "current";
  const stale = gate?.modelReview === "stale";
  const openBlockers = allFindings.filter((f) => f.severity === "blocker" && !f.resolution && !(f.source === "model" && stale)).length;
  const openJudgments = allFindings.filter((f) => f.severity === "judgment" && !f.resolution && !(f.source === "model" && stale)).length;
  const openSuggestions = allFindings.filter((f) => f.severity === "suggestion" && !f.resolution && !(f.source === "model" && stale)).length;
  const diff = useMemo(() => (compare ? wordDiff(d.lastDraft?.note_snapshot ?? s.note ?? "", parts.join("\n\n")) : []), [compare, parts, s.note, d.lastDraft]);
  const fromLastDraft = !!d.lastDraft && d.working?.format === format && d.working?.origin_draft_id === d.lastDraft.id;
  // Older drafts (before Oct 3, 2026) recorded meaning changes; newer ones record what they drew on and left out.
  const meaningChanges = fromLastDraft && !d.lastDraft.drew_on ? (d.lastDraft.changes ?? []).filter((c: any) => c.kind === "meaning_change") : [];

  // ---- Applying text ----
  const showWorking = (r: any) => {
    setParts(r.working.parts.length ? r.working.parts : [""]);
    setReply(r.working.source_reply ?? "");
    setShowReply(!!r.working.source_reply?.trim());
    setFormat(r.working.format);
    formatRef.current = r.working.format;
    setHash(r.working.text_hash);
    hashRef.current = r.working.text_hash;
    setGate(r.gate);
    setFindings(r.findings);
    dirty.current = false;
    setSaving("saved");
    cacheWorking(r);
  };
  const restoreSnapshot = async (before: TextSnapshot) => {
    if (busyRef.current) {
      toast("Wait for the current step to finish, then use Undo.");
      return;
    }
    setBusy("format");
    try {
      if (!(await flushPendingChanges())) return;
      if (formatRef.current !== before.format) {
        const r = await api(`/api/studies/${s.id}/writing-format`, { method: "POST", body: { format: before.format, base_hash: hashRef.current } });
        showWorking(r);
      }
      setParts(before.parts);
      setReply(before.reply);
      setShowReply(!!before.reply.trim());
      setSharpened(null);
      setAlternate(null);
      setUndo(null);
      saveText(before, "undo", true);
      await flushText();
      refresh();
    } catch (e: any) {
      toast(`That change could not be undone: ${e.message} Your current piece is still here. Try again.`, "error");
    } finally {
      setBusy(null);
    }
  };
  const rememberChange = (before: TextSnapshot, message: string) => {
    setUndo(before);
    toast(message, { action: { label: "Undo", run: () => void restoreSnapshot(before) } });
  };
  const undoLast = () => {
    if (undoRef.current) void restoreSnapshot(undoRef.current);
  };
  const copyText = async () => {
    try {
      await navigator.clipboard.writeText(parts.filter((p) => p.trim()).join("\n\n"));
      toast(`${formatLabel(format)} copied.`);
    } catch {
      toast("The clipboard wasn't available. Your piece is still here. Select the text and press ⌘C to copy it.", "error");
    }
  };

  // ---- Drafting ----
  const applyDraft = async (dr: any) => {
    if (!(await flushPendingChanges())) throw new Error("Your current piece did not save. It is still here; press ⌘S and try the new draft again.");
    const before = { parts, reply, format };
    const r = await api(`/api/studies/${s.id}/drafts/${dr.id}/apply`, { method: "POST", body: { base_hash: hashRef.current, base_format: formatRef.current } });
    showWorking(r);
    setAlternate(null);
    setSharpened(null);
    if (hasText) rememberChange(before, "New draft applied. Keep editing or refine it again.");
    refresh();
    return r;
  };
  const draftNow = async (kind: "edit" | "alternate") => {
    setBusy(kind === "edit" ? "draft" : "alt");
    try {
      if (!(await flushPendingChanges())) return;
      const fmt = format === "long" && !d.premium ? "thread" : format;
      const dr = await api(`/api/studies/${s.id}/drafts`, { method: "POST", body: { kind, format: fmt } });
      if (hasText) {
        setAlternate(dr);
        setSharpened(null);
      } else {
        const r = await applyDraft(dr);
        if (r.working.format === "thread" && fmt !== "thread") toast(`The idea needed more room, so it's a thread of ${r.working.parts.length}.`);
      }
      if (dr.notes_for_writer) toast(dr.notes_for_writer);
    } catch (e: any) {
      toast(e.message, "error");
    } finally {
      setBusy(null);
    }
  };
  const useAlternate = async () => {
    setBusy("draft");
    try {
      await applyDraft(alternate);
    } catch (e: any) {
      toast(e.message, "error");
    } finally {
      setBusy(null);
    }
  };

  // ---- Refining: each refinement starts from the saved piece, and suggestions are reviewed before they apply ----
  const refine = async (mode: RefinementMode = "polish", instruction = "") => {
    setBusy("sharpen");
    try {
      if (!(await flushPendingChanges())) return;
      const r: SharpenResult = await api(`/api/studies/${s.id}/sharpen`, { method: "POST", body: { mode, instruction: instruction.trim() || undefined } });
      if (r.unchanged) {
        setSharpened(null);
        toast(r.notes || "No changes suggested. Your piece reads well as it is.");
      } else {
        setSharpened(r);
        setAlternate(null);
      }
    } catch (e: any) {
      toast(e.message, "error");
    } finally {
      setBusy(null);
    }
  };
  const applySharpened = (next: string[]) => {
    if (!sharpened || sharpened.base_hash !== hashRef.current || dirty.current) {
      setSharpened(null);
      toast("Your piece has changed since these suggestions. Your edits are saved; choose a refinement again to use the latest text.");
      return;
    }
    const before = { parts, reply, format };
    setParts(next);
    saveText({ parts: next, reply, format }, "sharpen", true);
    setSharpened(null);
    rememberChange(before, "Edits applied. Keep writing or refine again.");
  };
  const useOpening = (line: string) => {
    if (busy) return;
    const before = { parts, reply, format };
    const [, ...rest] = (parts[0] ?? "").split("\n");
    const next = [[line, ...rest].join("\n"), ...parts.slice(1)];
    setParts(next);
    setSharpened(null);
    saveText({ parts: next, reply, format }, "typing", true);
    rememberChange(before, "New first line applied.");
  };

  // ---- Check ----
  const check = async () => {
    setBusy("check");
    try {
      if (!(await flushPendingChanges())) return false;
      const r = await api(`/api/studies/${s.id}/review`, { method: "POST" });
      setGate(r.gate);
      setFindings(r.findings);
      refresh();
      return true;
    } catch (e: any) {
      toast(e.message, "error");
      return false;
    } finally {
      setBusy(null);
    }
  };

  // ---- Editing ----
  const setPart = (i: number, v: string) => {
    const next = parts.map((p, j) => (j === i ? v : p));
    setParts(next);
    setSharpened(null);
    saveText({ parts: next, reply, format });
  };
  const addPart = () => {
    const next = [...parts, ""];
    setParts(next);
    saveText({ parts: next, reply, format });
    setTimeout(() => document.getElementById(`part-${next.length - 1}`)?.focus(), 30);
  };
  const removePart = (i: number) => {
    const next = parts.filter((_, j) => j !== i);
    setParts(next);
    saveText({ parts: next, reply, format }, "typing", true);
  };
  const setReplyText = (v: string) => {
    setReply(v);
    saveText({ parts, reply: v, format });
  };
  const openReply = () => {
    setShowReply(true);
    setTimeout(() => document.getElementById("part-reply")?.focus(), 30);
  };
  const removeReply = () => {
    setReply("");
    setShowReply(false);
    saveText({ parts, reply: "", format }, "typing", true);
  };
  const changeFormat = async (f: Format) => {
    if (f === format) return;
    setBusy("format");
    try {
      if (!(await flushPendingChanges())) return;
      const r = await api(`/api/studies/${s.id}/writing-format`, { method: "POST", body: { format: f, base_hash: hashRef.current } });
      showWorking(r);
      setAlternate(null);
      setSharpened(null);
      setUndo(null);
      setCompare(false);
      setWritingOwn(false);
      refresh();
    } catch (e: any) {
      toast(`The piece couldn't change: ${e.message} Your current piece is still here. Try again.`, "error");
    } finally {
      setBusy(null);
    }
  };
  const splitThread = async () => {
    setBusy("format");
    try {
      if (!(await flushPendingChanges())) return;
      const before = { parts, reply, format };
      const split = await api(`/api/studies/${s.id}/split`, { method: "POST", body: { text: parts.join("\n\n") } });
      const r = await putText({ parts: split.parts, reply, format: "thread" }, "split");
      showWorking(r);
      setSharpened(null);
      rememberChange(before, "Split into a thread. Your original shape is also saved.");
      refresh();
    } catch (e: any) {
      toast(`The post couldn't split: ${e.message} Your text is still here. Shorten it or try again.`, "error");
    } finally {
      setBusy(null);
    }
  };

  // ---- Check results ----
  const repair = async (f: FindingView) => {
    if (busy) return;
    if (f.code === "D1") {
      if (f.part_index === -1) return openReply();
      return splitThread();
    }
    if (f.code === "D2") return splitThread();
    const nextParts = [...parts];
    let nextReply = reply;
    if (f.code === "D8" && f.start !== null && f.span_text) {
      const p = nextParts[f.part_index];
      nextParts[f.part_index] = (p.slice(0, f.start) + p.slice(f.end!)).replace(/\s{2,}/g, " ").replace(/\s+([.,;])/g, "$1");
      nextReply = reply.includes(f.span_text) ? reply : `${reply.trim()}\n${f.span_text}`.trim();
      setShowReply(true);
    } else if (f.start !== null && f.end !== null && f.repair !== null) {
      const target = f.part_index === -1 ? reply : nextParts[f.part_index];
      const replaced = target.slice(0, f.start) + f.repair + target.slice(f.end);
      const tidy = replaced.replace(/ {2,}/g, " ").replace(/ +([.,;:])/g, "$1");
      if (f.part_index === -1) nextReply = tidy;
      else nextParts[f.part_index] = tidy;
    } else return;
    setParts(nextParts);
    setReply(nextReply);
    setSharpened(null);
    rememberChange({ parts, reply, format }, "Suggestion applied.");
    saveText({ parts: nextParts, reply: nextReply, format }, "repair_applied", true);
  };
  const decide = async (f: FindingView, resolution: "kept" | "dismissed" | null, reason?: string) => {
    if (busy) return;
    const decisionFormat = formatRef.current;
    try {
      if (f.source === "model") await api(`/api/findings/${f.id}`, { method: "PATCH", body: { resolution, reason } });
      else await api(`/api/studies/${s.id}/decisions`, { method: "POST", body: { code: f.code, span_text: f.span_text ?? "", resolution, reason } });
      const r = await api(`/api/studies/${s.id}`);
      // A decision changes review state only. Typing or switching pieces while it
      // saves must never write the earlier text back over the current piece.
      if (dirty.current || formatRef.current !== decisionFormat || r.working?.text_hash !== hashRef.current) return;
      setGate(r.gate);
      setFindings(r.findings);
      queryClient.setQueryData(["study", s.id], (old: any) => old ? { ...old, gate: r.gate, findings: r.findings, review: r.review } : old);
    } catch (e: any) {
      toast(e.message, "error");
    }
  };

  // ---- History ----
  const restoreVersion = (v: { parts: string[]; source_reply: string }) => {
    const before = { parts, reply, format };
    const next = { parts: v.parts.length ? v.parts : [""], reply: v.source_reply, format };
    setParts(next.parts);
    setReply(next.reply);
    setShowReply(!!next.reply.trim());
    setSharpened(null);
    setAlternate(null);
    saveText(next, "restore", true);
    rememberChange(before, "Restored that version of your piece.");
  };

  // ---- Finish: mark the study finished and write its readable file ----
  const finish = async (): Promise<{ where: string } | null> => {
    if (busyRef.current) return null;
    setBusy("finish");
    try {
      if (!(await flushPendingChanges())) return null;
      const r = await api(`/api/studies/${s.id}/save`, { method: "POST" });
      // The finished page opens from the cached study, so it must already say "finished".
      queryClient.setQueryData(["study", s.id], (old: any) => (old ? { ...old, study: { ...old.study, ...r.study } } : old));
      queryClient.invalidateQueries({ queryKey: ["studies"] });
      queryClient.invalidateQueries({ queryKey: ["today"] });
      refresh();
      return { where: r.where };
    } catch (e: any) {
      toast(e.message, "error");
      return null;
    } finally {
      setBusy(null);
    }
  };

  return {
    s, format, parts, reply, hash, gate, findings, allFindings, sharpened, setSharpened, busy, compare, setCompare, showReply, alternate, setAlternate,
    publishing, setPublishing, writingOwn, setWritingOwn, saving, undo, noteWords, canDraft, hasText, xFormat, published, partlyPosted,
    checked, stale, openBlockers, openJudgments, openSuggestions, diff, fromLastDraft, meaningChanges,
    copyText, draftNow, useAlternate, refine, applySharpened, useOpening, check, setPart, addPart, removePart, setReplyText, openReply, removeReply,
    changeFormat, splitThread, repair, decide, restoreVersion, undoLast, finish, flushText,
  };
}

export type Writing = ReturnType<typeof useWriting>;
