// A study's title: chosen for you from the first draft (or on request), and yours to rename at any time.
// Before there's anything to name, it stays out of the way.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Sparkles } from "lucide-react";
import { api, queryClient } from "../api";
import { Dots, useToast } from "../components/ui";
import { useStudyField } from "./fields";

export function TitleEditor({ study, trigger, triggerClassName, align = "left" }: { study: any; trigger: ReactNode; triggerClassName: string; align?: "left" | "right" }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => !wrap.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div className="title-wrap" ref={wrap}>
      <button className={triggerClassName} onClick={() => setOpen((x) => !x)} aria-expanded={open} aria-haspopup="dialog" title={study.title ? "Rename this study" : "Name this study"}>
        {trigger}
      </button>
      {open && <TitlePop study={study} align={align} onDone={() => setOpen(false)} />}
    </div>
  );
}

/** Open only while editing, so its autosave (and the header's save state) exists only then; closing saves. */
function TitlePop({ study, align, onDone }: { study: any; align: "left" | "right"; onDone: () => void }) {
  const toast = useToast();
  const [value, setValue] = useState<string>(study.title ?? "");
  const [choosing, setChoosing] = useState(false);
  const [offered, setOffered] = useState<string[]>([]);
  const field = useStudyField(study.id, "title");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setTimeout(() => input.current?.select(), 0);
  }, []);

  const type = (v: string) => {
    setValue(v);
    field.change(v.trim());
    queryClient.setQueryData(["study", study.id], (old: any) => (old ? { ...old, study: { ...old.study, title: v.trim() || null, title_auto: 0 } } : old));
  };
  const chooseForMe = async () => {
    setChoosing(true);
    try {
      await field.flush();
      const before = study.title ?? "";
      const r = await api(`/api/studies/${study.id}/title`, { method: "POST", body: { previous: [...offered, ...(before ? [before] : [])].slice(-8) } });
      setOffered((o) => [...o, r.title]);
      setValue(r.title);
      queryClient.setQueryData(["study", study.id], (old: any) => (old ? { ...old, study: { ...old.study, title: r.title, title_auto: 1 } } : old));
      queryClient.invalidateQueries({ queryKey: ["studies"] });
    } catch (e: any) {
      toast(e.message, "error");
    } finally {
      setChoosing(false);
    }
  };

  return (
    <div className={`title-pop ${align}`} role="dialog" aria-label="Study title">
      <label className="label" htmlFor="study-title-input">Title</label>
      <input
        id="study-title-input"
        ref={input}
        className="title-input"
        value={value}
        placeholder="Name this study"
        maxLength={120}
        onChange={(e) => type(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onDone();
          }
        }}
      />
      <div className="title-row">
        <button className="btn sm secondary" onClick={() => void chooseForMe()} disabled={choosing}>
          {choosing ? <Dots label="Choosing" /> : <><Sparkles className="lucide" /> {offered.length || study.title_auto ? "Another" : "Choose for me"}</>}
        </button>
        <span className="title-hint">
          {study.title_auto ? "Chosen from your study. Type to make it yours." : study.title ? "Yours. It won't be changed for you." : "Or leave it: your first draft will name it."}
        </span>
      </div>
    </div>
  );
}
