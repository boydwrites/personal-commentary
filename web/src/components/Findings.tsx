import { useState } from "react";
import { AlertOctagon, HelpCircle, Lightbulb } from "lucide-react";

export interface FindingView {
  key: string;
  id?: string;
  source: "deterministic" | "model";
  code: string;
  name: string;
  severity: "blocker" | "judgment" | "suggestion";
  part_index: number;
  start: number | null;
  end: number | null;
  span_text: string | null;
  problem: string;
  repair: string | null;
  repair_label?: string;
  support?: { ref: string; display: string; text: string }[];
  resolution?: string | null;
  resolution_reason?: string | null;
}

const KIND = {
  blocker: { label: "Must fix", icon: AlertOctagon },
  judgment: { label: "Your call", icon: HelpCircle },
  suggestion: { label: "Suggestion", icon: Lightbulb },
} as const;
const ORDER = { blocker: 0, judgment: 1, suggestion: 2 };

export function Findings({
  findings, stale, onRepair, onDecide, multiPart,
}: {
  findings: FindingView[];
  stale: boolean;
  onRepair: (f: FindingView) => void;
  onDecide: (f: FindingView, resolution: "kept" | "dismissed" | null, reason?: string) => void;
  multiPart: boolean;
}) {
  const [keeping, setKeeping] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [versesOpen, setVersesOpen] = useState<Set<string>>(new Set());
  // After an edit, an older finding stays while its words are still in the post; the next Check replaces it.
  const shown = findings.filter((f) => !(f.source === "model" && stale && (f.start === null || f.resolution))).sort((a, b) => (a.resolution ? 1 : 0) - (b.resolution ? 1 : 0) || ORDER[a.severity] - ORDER[b.severity]);
  if (!shown.length) return null;
  const reasonWords = reason.trim().split(/\s+/).filter(Boolean).length;
  return (
    <div className="findings" aria-label="Check results">
      {shown.map((f) => {
        const k = KIND[f.severity];
        const resolved = !!f.resolution;
        const structural = ["D1", "D2", "D8"].includes(f.code);
        const canRepair = (f.repair !== null && f.start !== null) || structural;
        const where = multiPart && f.part_index >= 0 ? `Part ${f.part_index + 1}` : f.part_index === -1 ? "Sources reply" : null;
        return (
          <div key={f.key} className={`finding ${f.severity} ${resolved ? "resolved" : ""}`}>
            <div className="finding-kind">
              <k.icon className="lucide" aria-hidden="true" />
              {resolved ? (f.resolution === "kept" ? "Kept" : "Dismissed") : k.label}
              {where && <span style={{ opacity: 0.7 }}>· {where}</span>}
            </div>
            {f.span_text && <div className="span">“{f.span_text.length > 160 ? f.span_text.slice(0, 160) + "…" : f.span_text}”</div>}
            <div className="problem">{f.problem}</div>
            {f.code !== "D5" && f.repair && !structural && !f.repair_label && <div className="fix suggested">{f.repair}</div>}
            {!canRepair && f.code !== "D5" && !f.repair && f.repair_label && <div className="fix">{f.repair_label}</div>}
            {(f.support ?? []).slice(0, versesOpen.has(f.key) ? undefined : 2).map((s) => (
              <div key={s.ref} className="support">
                <b style={{ fontFamily: "var(--sans)", fontSize: 12 }}>{s.display}</b> — {s.text}
              </div>
            ))}
            {(f.support?.length ?? 0) > 2 && !versesOpen.has(f.key) && (
              <button className="text-btn" onClick={() => setVersesOpen((x) => new Set(x).add(f.key))}>
                {f.support!.length - 2} more verse{f.support!.length - 2 === 1 ? "" : "s"}
              </button>
            )}
            {f.resolution_reason && <div className="fix">Your reason: {f.resolution_reason}</div>}
            {!resolved && keeping !== f.key && (
              <div className="actions">
                {canRepair && (
                  <button className="btn sm secondary" onClick={() => onRepair(f)} title={f.repair && !structural ? `Replace with: ${f.repair || "(nothing)"}` : undefined}>
                    {f.repair_label ?? (f.repair ? "Use this" : "Remove it")}
                  </button>
                )}
                {f.severity === "judgment" && (
                  <button
                    className="btn sm ghost"
                    onClick={() => {
                      setKeeping(f.key);
                      setReason("");
                    }}
                  >
                    Keep it
                  </button>
                )}
                {f.severity === "suggestion" && (
                  <button className="btn sm ghost" onClick={() => onDecide(f, "dismissed")}>
                    Dismiss
                  </button>
                )}
              </div>
            )}
            {keeping === f.key && (
              <form
                className="row wrap"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (reasonWords < 5) return;
                  onDecide(f, "kept", reason);
                  setKeeping(null);
                }}
              >
                <input className="input grow" autoFocus placeholder="Why keep it? A sentence for your records." value={reason} onChange={(e) => setReason(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setKeeping(null)} style={{ minWidth: 200 }} />
                <button className="btn sm secondary" type="submit" disabled={reasonWords < 5}>
                  Keep
                </button>
                <span className="reason-hint" aria-live="polite">
                  {reasonWords < 5 ? `A short sentence — ${5 - reasonWords} more word${5 - reasonWords === 1 ? "" : "s"}.` : "Press Enter to keep it."}
                </span>
              </form>
            )}
            {resolved && (
              <div>
                <button className="text-btn" onClick={() => onDecide(f, null)}>Undo</button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
