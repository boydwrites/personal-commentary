import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";
import { api, queryClient } from "../api";
import { Mark } from "../components/Logo";
import { DatasetsSection, KeyField } from "./Settings";

/** First run: welcome, the local library (skipped when it's already here), and an optional OpenAI key. */
export function Setup({ status }: { status: any }) {
  const datasets = useQuery({ queryKey: ["datasets"], queryFn: () => api<any[]>("/api/datasets"), initialData: status.datasets });
  const allPresent = (datasets.data ?? []).every((d: any) => d.present);
  const bsbReady = (datasets.data ?? []).find((d: any) => d.id === "bsb")?.present;
  const [steps] = useState(() => ["welcome", ...(allPresent ? [] : ["library"]), ...(status.keys.openai ? [] : ["openai"])]);
  const [i, setI] = useState(0);
  const step = steps[Math.min(i, steps.length - 1)];
  const last = i >= steps.length - 1;

  const finish = async () => {
    await api("/api/preferences", { method: "PUT", body: { onboarded: true } });
    await queryClient.invalidateQueries({ queryKey: ["status"] });
  };
  const next = () => (last ? finish() : setI(i + 1));

  return (
    <div className="setup">
      <div className="setup-card" key={step}>
        {step === "welcome" && (
          <>
            <Mark size={84} />
            <h1>Personal Commentary</h1>
            <p className="lead">Study Scripture each day. Keep what you learn, and shape it into something worth returning to or sharing.</p>
            <p className="muted">Begin with your thoughts, explore the research, and save what stands out. Then choose a journal entry, devotional, X post, or organized study notes. Edit and refine your draft as often as you like.</p>
          </>
        )}
        {step === "library" && (
          <>
            <h1>Your library</h1>
            <p className="muted">The Bible and the commentaries live on this Mac, so reading works offline and research is quick.</p>
            <DatasetsSection />
          </>
        )}
        {step === "openai" && (
          <>
            <h1>Connect OpenAI</h1>
            <p className="muted">GPT-6 Luna prepares research briefs and starting questions. GPT-6.1 Sol helps draft, refine, and check your writing. Reading and writing your own notes work without a key.</p>
            <KeyField name="openai_api_key" present={status.keys.openai} />
          </>
        )}
        <div className="setup-foot">
          <div className="setup-dots" aria-label={`Step ${i + 1} of ${steps.length}`}>
            {steps.length > 1 && steps.map((s, k) => <span key={s} className={k === i ? "on" : ""} />)}
          </div>
          {i > 0 && <button className="btn ghost" onClick={() => setI(i - 1)}>Back</button>}
          {step === "openai" && !status.keys.openai && <button className="btn ghost" onClick={finish}>Skip for now</button>}
          <button className="btn primary lg" onClick={next} disabled={step === "library" && !bsbReady}>
            {step === "welcome" ? "Begin" : last ? "Open Today" : "Continue"} <ArrowRight className="lucide" />
          </button>
        </div>
        {step === "library" && !bsbReady && <p className="small muted" style={{ textAlign: "right", marginTop: 10 }}>The Bible text is needed to continue.</p>}
      </div>
    </div>
  );
}
