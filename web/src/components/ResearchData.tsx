import { memo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ResearchCorpusData, ResearchCorpusInspection, ResearchSourceRights } from "../../../shared/research";
import { api, fmtDate, money } from "../api";
import { Dots, useToast } from "./ui";

const STATUS_LABEL = {
  blocked: "Private — review blocked",
  needs_review: "Private — needs your review",
  approved: "Approved for local download",
  revoked: "Approval revoked — private",
} as const;

/** Deliberately lazy: source snapshots can be large, and this is secondary to reading the brief. */
export function ResearchData({ studyId, revision, embedded = false }: { studyId: string; revision: string; embedded?: boolean }) {
  const [open, setOpen] = useState(embedded);
  const inspection = useQuery({
    queryKey: ["research-corpus", studyId, revision],
    queryFn: () => api<ResearchCorpusInspection>(`/api/studies/${studyId}/corpus`),
    enabled: open,
    staleTime: 0,
  });
  return (
    <section aria-label="Reusable research" style={embedded ? undefined : { borderTop: "1px solid var(--line)", marginTop: 24, paddingTop: 16 }}>
      {!embedded && (
        <button className="text-btn" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {open ? "Hide reusable research" : "Reusable research"}
        </button>
      )}
      {open && (
        <div style={{ marginTop: embedded ? 0 : 14 }}>
          <p className="small muted">Review passage research separately from your private study. Your thoughts, selections, and drafts stay out of this download. Nothing is uploaded.</p>
          {inspection.isPending && <Dots label="Preparing review" />}
          {inspection.isError && (
            <div role="alert" className="small">
              <p>The research review could not load. Your brief and writing are still saved. Try loading the review again.</p>
              <button className="btn sm secondary" onClick={() => void inspection.refetch()}>Try again</button>
            </div>
          )}
          {inspection.data && !inspection.isError && (
            <CorpusReview key={`${studyId}:${inspection.data.hash}:${inspection.data.review?.id ?? "new"}`} studyId={studyId} inspection={inspection.data} reload={() => inspection.refetch()} />
          )}
        </div>
      )}
    </section>
  );
}

function CorpusReview({ studyId, inspection, reload }: { studyId: string; inspection: ResearchCorpusInspection; reload: () => Promise<unknown> }) {
  const toast = useToast();
  const [busy, setBusy] = useState<"review" | "revoke" | null>(null);
  const [privacy, setPrivacy] = useState(false);
  const [quality, setQuality] = useState(false);
  const [rights, setRights] = useState(false);
  const [sourceRights, setSourceRights] = useState<ResearchSourceRights[]>(() => inspection.dependencies.map((d) => ({
    sourceId: d.sourceId, licenseUrl: d.licenseUrl ?? "", attribution: d.attribution ?? "", provenanceUrl: d.provenanceUrl ?? "",
  })));
  const updateRights = (sourceId: string, field: "licenseUrl" | "attribution" | "provenanceUrl", value: string) =>
    setSourceRights((previous) => previous.map((r) => r.sourceId === sourceId ? { ...r, [field]: value } : r));
  const incompleteRights = sourceRights.filter((r) => !isHttps(r.licenseUrl) || !isHttps(r.provenanceUrl) || !r.attribution.trim()).length;
  const approved = inspection.status === "approved";
  const blocked = inspection.status === "blocked";

  const saveDecision = async (decision: "review" | "revoke") => {
    setBusy(decision);
    try {
      await api(`/api/studies/${studyId}/corpus/${decision}`, { method: "POST", body: decision === "revoke" ? { expectedHash: inspection.hash } : {
        expectedHash: inspection.hash, reviewedPrivacy: privacy, reviewedQuality: quality, reviewedRights: rights,
        sourceRights: sourceRights.map((r) => ({ sourceId: r.sourceId, licenseUrl: r.licenseUrl.trim(), attribution: r.attribution.trim(), provenanceUrl: r.provenanceUrl.trim() })),
      } });
      toast(decision === "review" ? "Your review is saved. This research can now be downloaded locally." : "Approval revoked. Your study and research are still saved.");
      await reload();
    } catch (e: unknown) {
      const detail = e instanceof Error ? e.message : "The request did not finish.";
      toast(`${decision === "review" ? "Your research approval" : "Revocation"} did not save: ${detail} Your study is still saved. Refresh this review and try again.`, "error");
      await reload();
    } finally {
      setBusy(null);
    }
  };


  return (
    <div className="small" style={{ display: "grid", gap: 16 }}>
      <div>
        <strong>{STATUS_LABEL[inspection.status]}</strong>
        {inspection.review && <span className="muted"> · {fmtDate(inspection.review.createdAt)}</span>}
        <p className="muted" style={{ marginBottom: 0 }}>{inspection.counts.artifacts} findings · {inspection.counts.sources} source snapshots · {inspection.counts.excerpts} excerpts · {inspection.counts.evidence} evidence links</p>
      </div>
      {inspection.blockers.length > 0 && (
        <div className="partial-note" style={{ display: "block", margin: 0 }}>
          <ul style={{ paddingLeft: 20, margin: 0 }}>{inspection.blockers.map((b, i) => <li key={`${b.code}:${i}`}>{b.message}</li>)}</ul>
          <p style={{ marginBottom: 0 }}>Your private brief and study download remain available. Resolve the listed issues before approving reusable research.</p>
        </div>
      )}
      {inspection.preview && <CorpusPreview data={inspection.preview} />}
      {inspection.dependencies.length > 0 && (
        <details>
          <summary style={{ cursor: "pointer", fontWeight: 600 }}>Source rights and attribution ({inspection.dependencies.length})</summary>
          <p className="muted">Inspect every source, including those behind the findings. Public-domain or permitted attribution licenses still need supporting links and an attribution statement.</p>
          {inspection.dependencies.map((dependency, index) => {
            const entry = sourceRights[index];
            return (
              <details key={dependency.sourceId} style={{ padding: "12px 0", borderTop: "1px solid var(--line)" }}>
                <summary style={{ cursor: "pointer" }}>{dependency.title} · {dependency.rights.replaceAll("_", " ")}{!dependency.eligible ? " · not eligible" : ""}</summary>
                {!approved && !blocked ? (
                  <div style={{ display: "grid", gap: 10, marginTop: 12 }}>
                    <RightsField label="License evidence (HTTPS URL)" value={entry.licenseUrl} onChange={(value) => updateRights(dependency.sourceId, "licenseUrl", value)} disabled={!!busy} url />
                    <RightsField label="Source provenance (HTTPS URL)" value={entry.provenanceUrl} onChange={(value) => updateRights(dependency.sourceId, "provenanceUrl", value)} disabled={!!busy} url />
                    <RightsField label="Attribution statement" value={entry.attribution} onChange={(value) => updateRights(dependency.sourceId, "attribution", value)} disabled={!!busy} />
                  </div>
                ) : (
                  <div style={{ marginTop: 10, overflowWrap: "anywhere" }}>
                    <p>{dependency.attribution ?? "No attribution statement recorded."}</p>
                    {dependency.licenseUrl && <p><SafeLink href={dependency.licenseUrl}>License evidence</SafeLink></p>}
                    {dependency.provenanceUrl && <p><SafeLink href={dependency.provenanceUrl}>Source provenance</SafeLink></p>}
                  </div>
                )}
              </details>
            );
          })}
        </details>
      )}
      {!blocked && !approved && inspection.preview && (
        <form onSubmit={(e) => { e.preventDefault(); void saveDecision("review"); }}>
          <fieldset disabled={!!busy} style={{ padding: 0, border: 0, margin: 0, display: "grid", gap: 12 }}>
            <legend style={{ marginBottom: 12, fontWeight: 600 }}>Your review of this exact content</legend>
            <Attestation checked={privacy} onChange={setPrivacy}>I reviewed the content and source snapshots: they contain no private thoughts, personal information, or writing.</Attestation>
            <Attestation checked={quality} onChange={setQuality}>I reviewed the findings and their evidence, including limitations and disagreements, for reuse.</Attestation>
            <Attestation checked={rights} onChange={setRights}>I checked every source’s reuse rights and supplied its license evidence, provenance, and attribution.</Attestation>
            {incompleteRights > 0 && <p className="muted" style={{ margin: 0 }}>{incompleteRights} source{incompleteRights === 1 ? " still needs" : "s still need"} complete rights documentation above.</p>}
            <div className="row wrap">
              <button className="btn sm secondary" type="submit" disabled={!privacy || !quality || !rights || incompleteRights > 0}>{busy === "review" ? <Dots label="Saving review" /> : "Approve local research download"}</button>
            </div>
          </fieldset>
          <p className="tiny muted">Approval applies to this version only. Changed content needs a new review. No cloud upload occurs.</p>
        </form>
      )}
      {approved && (
        <div>
          <div className="row wrap">
            <a className="btn sm secondary" href={`/api/studies/${studyId}/corpus.json`} download aria-disabled={!!busy} onClick={(event) => { if (busy) event.preventDefault(); }}>Download reviewed research</a>
            <button className="text-btn" disabled={!!busy} onClick={() => void saveDecision("revoke")}>{busy === "revoke" ? "Revoking…" : "Revoke approval"}</button>
          </div>
          <p className="tiny muted">Revoking prevents future downloads here; it cannot remove copies already downloaded. Your study stays saved.</p>
        </div>
      )}
      <button className="text-btn" style={{ justifySelf: "start" }} disabled={!!busy} onClick={() => void reload()}>Refresh review</button>
    </div>
  );
}

const CorpusPreview = memo(function CorpusPreview({ data }: { data: ResearchCorpusData }) {
  const [showExact, setShowExact] = useState(false);
  return (
    <div style={{ display: "grid", gap: 14 }}>
      <details>
        <summary style={{ cursor: "pointer", fontWeight: 600 }}>Review exact findings and evidence ({data.artifacts.length})</summary>
        {data.runs.map((run) => <div key={run.id}>{run.contextSummary && <p style={{ whiteSpace: "pre-wrap" }}>{run.contextSummary}</p>}{run.qualification && <p className="muted">{run.qualification}</p>}</div>)}
        {data.artifacts.map((artifact) => (
          <article key={artifact.id} style={{ padding: "16px 0", borderTop: "1px solid var(--line)" }}>
            <b>{artifact.title}</b>{artifact.authorName && <span className="muted"> · {artifact.authorName}</span>}
            <p style={{ whiteSpace: "pre-wrap" }}>{artifact.displayBody}</p>
            {artifact.limitation && <p className="muted">Limitation: {artifact.limitation}</p>}
            {artifact.disagreement && <p className="muted">Disagreement: {artifact.disagreement}</p>}
            <p className="tiny muted">Source: {artifact.sourceStatus} · Quotation: {artifact.quotationStatus}</p>
            {data.evidence.filter((e) => e.artifactId === artifact.id).map((evidence) => {
              const excerpt = data.excerpts.find((e) => e.id === evidence.excerptId);
              const source = data.sources.find((s) => s.id === excerpt?.sourceId);
              return (
                <details key={evidence.id} style={{ marginTop: 10 }}>
                  <summary style={{ cursor: "pointer" }}>{source?.title ?? "Evidence"} · {evidence.use.replaceAll("_", " ")}</summary>
                  <p style={{ whiteSpace: "pre-wrap" }}>{excerpt?.text ?? "Evidence excerpt is missing."}</p>
                  <p className="tiny muted">Quotation match: {evidence.match ?? "no quotation"}</p>
                  {source?.url && <SafeLink href={source.url}>Open source</SafeLink>}
                </details>
              );
            })}
          </article>
        ))}
      </details>
      <details>
        <summary style={{ cursor: "pointer", fontWeight: 600 }}>Review full source snapshots ({data.sources.length})</summary>
        {data.sources.map((source) => (
          <details key={source.id} style={{ padding: "12px 0", borderTop: "1px solid var(--line)" }}>
            <summary style={{ cursor: "pointer" }}>{source.title}{source.authorName ? ` · ${source.authorName}` : ""}</summary>
            <p className="muted">{[source.work, source.locator, source.edition, source.rights.replaceAll("_", " ")].filter(Boolean).join(" · ")}</p>
            {source.url && <SafeLink href={source.url}>Open source</SafeLink>}
            <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: 420, overflowY: "auto", fontFamily: "inherit" }} tabIndex={0} aria-label={`Stored source text: ${source.title}`}>{source.text ?? "No full snapshot stored; inspect the saved excerpts in the exact data below."}</pre>
          </details>
        ))}
      </details>
      <details>
        <summary style={{ cursor: "pointer", fontWeight: 600 }}>Models, prompts, and costs</summary>
        <p>{data.modelCalls.length} model calls · {money(data.costEvents.reduce((total, event) => total + event.usdMicros, 0))}{data.costEvents.some((event) => event.estimated) ? " (includes estimates)" : ""}</p>
        <ul style={{ paddingLeft: 20 }}>{data.modelCalls.map((call) => <li key={call.id}>{call.servedModel ?? call.requestedModel} · prompt {call.promptVersion} · {call.outcome}</li>)}</ul>
      </details>
      <details onToggle={(event) => setShowExact(event.currentTarget.open)}>
        <summary style={{ cursor: "pointer", fontWeight: 600 }}>Exact data for this review</summary>
        <p className="muted">All proposed content, including stored original model text, evidence links, source identifiers, and research metadata.</p>
        <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: 480, overflowY: "auto", fontSize: 11 }} tabIndex={0} aria-label="Exact research data">{showExact ? JSON.stringify(data, null, 2) : ""}</pre>
      </details>
    </div>
  );
});

function isHttps(value: string) {
  try { const url = new URL(value.trim()); return url.protocol === "https:" && !url.username && !url.password; } catch { return false; }
}
function SafeLink({ href, children }: { href: string; children: ReactNode }) {
  return /^https?:\/\//i.test(href) ? <a className="link" href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}: {href}</span>;
}
function RightsField({ label, value, onChange, disabled, url }: { label: string; value: string; onChange: (value: string) => void; disabled: boolean; url?: boolean }) {
  return <label className="field" style={{ margin: 0 }}><span className="field-label">{label}</span><input className="input" type={url ? "url" : "text"} value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} autoComplete="off" /></label>;
}
function Attestation({ checked, onChange, children }: { checked: boolean; onChange: (value: boolean) => void; children: ReactNode }) {
  return <label style={{ display: "flex", gap: 10, alignItems: "flex-start" }}><input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} style={{ marginTop: 3, flexShrink: 0 }} /><span>{children}</span></label>;
}
