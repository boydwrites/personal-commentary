// A study: Read → Research → Write, with your notebook beside every stage, and a finished page when you're done.
// /study/:id opens the right place (the finished page, or the stage you were on); /study/:id/<stage> opens a stage.
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, money, navigate, queryClient, useServerEvent } from "../api";
import { ChevronLeft } from "lucide-react";
import { Dots, Empty, Link, Modal, useMedia, useToast, type MenuItem } from "../components/ui";
import { backTarget } from "../backTo";
import { EvidenceDrawer } from "../components/EvidenceDrawer";
import { HighlightSelection } from "../components/HighlightSelection";
import { ResearchData } from "../components/ResearchData";
import { flushPendingChanges } from "../desktop";
import { CtaSlot, StudyHeader, type Stage } from "../study/StudyHeader";
import { StageFrame } from "../study/StageFrame";
import { ReadStage } from "../study/ReadStage";
import { ResearchStage } from "../study/ResearchStage";
import { WriteStage } from "../study/WriteStage";
import { Finished, markJustFinished, reveal } from "../study/Finished";
import { Notebook } from "../study/Notebook";

export const STAGES: Stage[] = ["read", "research", "write"];

/** Where an unfinished study opens: the furthest stage you've reached. */
function defaultStage(d: any): Stage {
  if ((d.availableFormats?.length ?? 0) > 0 || d.working?.parts?.some((p: string) => p.trim())) return "write";
  if (d.runs.length > 0) return "research";
  return "read";
}

export function Study({ id, stage }: { id: string; stage: Stage | null }) {
  const toast = useToast();
  const q = useQuery({ queryKey: ["study", id], queryFn: () => api(`/api/studies/${id}`) });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["study", id] });
  useServerEvent("run", (e: any) => {
    if (e.studyId === id || !e.studyId) refresh();
  });
  const wide = useMedia("(min-width: 1000px)");
  const [sheet, setSheet] = useState(false);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const [evidenceFor, setEvidenceFor] = useState<string | null>(null);
  const [dataOpen, setDataOpen] = useState(false);
  useEffect(() => setSheet(false), [stage, wide]);

  const finishedStatus = q.data && ["saved", "published"].includes(q.data.study.status);
  // An unfinished study's plain address opens the stage you reached.
  useEffect(() => {
    if (!stage && q.data && !finishedStatus) void navigate(`/study/${id}/${defaultStage(q.data)}`, true);
  }, [stage, q.data, finishedStatus, id]);

  // ⌘S saves everything now (it all autosaves anyway) and says so.
  useEffect(() => {
    const onKey = async (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "s") return;
      e.preventDefault();
      const ok = await flushPendingChanges();
      toast(ok ? "Everything is saved." : "Some words didn't save. They're still on screen; try ⌘S again.", ok ? "info" : "error");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toast]);

  // Active-time tracking: a second counts when the window is visible and there was input in the last 60 s.
  const lastInput = useRef(Date.now());
  useEffect(() => {
    const mark = () => (lastInput.current = Date.now());
    const evs = ["keydown", "pointerdown", "scroll", "selectionchange"];
    evs.forEach((ev) => document.addEventListener(ev, mark, true));
    let pending = 0;
    const tick = setInterval(() => {
      if (document.visibilityState === "visible" && Date.now() - lastInput.current < 60_000) pending++;
      if (pending >= 15) {
        api("/api/activity", { method: "POST", body: { studyId: id, seconds: pending } }).catch(() => {});
        pending = 0;
      }
    }, 1000);
    return () => {
      clearInterval(tick);
      evs.forEach((ev) => document.removeEventListener(ev, mark, true));
      if (pending) api("/api/activity", { method: "POST", body: { studyId: id, seconds: pending } }).catch(() => {});
    };
  }, [id]);

  if (q.isLoading) {
    const back = backTarget();
    return (
      <div className="study">
        <header className="sh">
          <div className="sh-left">
            <Link to={back.to} className="sh-back"><ChevronLeft className="lucide" /><span>{back.label}</span></Link>
          </div>
        </header>
        <div className="study-loading" role="status"><Dots label="Opening the study" /><span>Opening the study</span></div>
      </div>
    );
  }
  if (q.error)
    return (
      <div className="page">
        <Empty title="This study didn't open.">
          {(q.error as Error).message} <Link className="link" to="/">Back to Today</Link>
        </Empty>
      </div>
    );
  const d = q.data;
  const s = d.study;
  if (!stage && !finishedStatus) return null;

  const invalidateLists = () => {
    queryClient.invalidateQueries({ queryKey: ["today"] });
    queryClient.invalidateQueries({ queryKey: ["studies"] });
  };
  const setStatus = async (body: any, msg: string) => {
    try {
      await api(`/api/studies/${s.id}`, { method: "PATCH", body });
      refresh();
      invalidateLists();
      toast(msg);
    } catch (e: any) {
      toast(e.message, "error");
    }
  };
  const finish = async () => {
    try {
      if (!(await flushPendingChanges())) return;
      const r = await api(`/api/studies/${s.id}/save`, { method: "POST" });
      queryClient.setQueryData(["study", s.id], (old: any) => (old ? { ...old, study: { ...old.study, ...r.study } } : old));
      invalidateLists();
      refresh();
      markJustFinished(s.id, r.where);
      void navigate(`/study/${s.id}`);
    } catch (e: any) {
      toast(e.message, "error");
    }
  };
  const archive = async () => {
    try {
      if (!(await flushPendingChanges())) return;
      await api(`/api/studies/${s.id}`, { method: "DELETE" });
      invalidateLists();
      void navigate("/");
      toast(`${s.display_ref} archived. It's in the Library under Archived.`);
    } catch (e: any) {
      toast(e.message, "error");
    }
  };
  const mins = Math.round(d.activity.activeSeconds / 60);
  const menu: MenuItem[] = [
    s.status === "open"
      ? { label: "Finish study", onSelect: () => void finish() }
      : s.status === "saved"
        ? { label: "Mark as in progress", onSelect: () => void setStatus({ status: "open" }, "Back in progress. It's on Today under Continue.") }
        : s.status === "archived"
          ? { label: "Restore from archive", onSelect: () => void setStatus({ status: "open" }, "Restored. It's on Today under Continue.") }
          : { note: "Posted to X." },
    ...(finishedStatus && stage ? [{ label: "View the finished page", onSelect: () => void navigate(`/study/${s.id}`) }] : []),
    ...(s.record_path ? [{ label: "Show file in Finder", onSelect: () => reveal(s.id, toast) }] : []),
    { label: "Export as Markdown", onSelect: async () => { if (await flushPendingChanges()) window.location.href = `/api/studies/${s.id}/export.md`; } },
    { label: "Download study data", onSelect: async () => { if (await flushPendingChanges()) window.location.href = `/api/studies/${s.id}/export.json`; } },
    ...(d.cards.length ? [{ label: "Research data…", onSelect: () => setDataOpen(true) }] : []),
    "divider",
    { note: <>{mins ? `${mins} min of your time` : "Just started"} · {money(d.costMicros)} spent</> },
    ...(s.status !== "published" && s.status !== "archived" ? (["divider", { label: "Archive study", danger: true, onSelect: () => void archive() }] as MenuItem[]) : []),
  ];

  const layout = { wide, sheet, setSheet };
  const highlights = d.cards.filter((c: any) => c.selected).length;
  const notebook = (st: Stage) => <Notebook d={d} refresh={refresh} onEvidence={setEvidenceFor} stage={st} />;
  let body;
  if (!stage) body = <div className="stage stage-finished"><div className="stage-main"><Finished d={d} refresh={refresh} onEvidence={setEvidenceFor} /></div></div>;
  else if (stage === "read") body = <StageFrame layout={layout} kind="read" inlineWhenNarrow main={<ReadStage d={d} refresh={refresh} />} aside={notebook("read")} asideLabel="Notebook" />;
  else if (stage === "research") body = <StageFrame layout={layout} kind="research" main={<ResearchStage d={d} refresh={refresh} onEvidence={setEvidenceFor} />} aside={notebook("research")} asideLabel="Notebook" />;
  else body = <WriteStage d={d} refresh={refresh} onEvidence={setEvidenceFor} layout={layout} />;

  return (
    <CtaSlot.Provider value={slot}>
      <div className="study">
        <StudyHeader
          d={d}
          stage={stage ?? "finished"}
          menu={menu}
          setSlot={setSlot}
          notebookToggle={!wide && stage && stage !== "read" ? { count: highlights, open: () => setSheet(true) } : null}
        />
        {body}
        <EvidenceDrawer cardId={evidenceFor} d={d} onClose={() => setEvidenceFor(null)} onChanged={refresh} />
        <HighlightSelection studyId={s.id} onChanged={refresh} />
        <Modal open={dataOpen} onClose={() => setDataOpen(false)} label="Research data" wide>
          <h2>Research data</h2>
          <ResearchData studyId={s.id} revision={`${d.runs.at(-1)?.id}:${d.runs.at(-1)?.status}`} embedded />
        </Modal>
      </div>
    </CtaSlot.Provider>
  );
}
