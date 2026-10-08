import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Check, X } from "lucide-react";
import { api, money, queryClient, useServerEvent, fmtDate } from "../api";
import { useToast, Dots } from "../components/ui";
import { VoiceLibrary } from "../components/Voice";

export function usePrefs() {
  const q = useQuery({ queryKey: ["prefs"], queryFn: () => api("/api/preferences") });
  const save = async (patch: any) => {
    const r = await api("/api/preferences", { method: "PUT", body: patch });
    queryClient.setQueryData(["prefs"], r);
    queryClient.invalidateQueries({ queryKey: ["status"] });
    return r;
  };
  return { prefs: q.data, save };
}

export const FRAME_EXAMPLE = "Historic, creedal Christianity (Nicene Creed as the floor). [My tradition] by conviction; fair to Catholic, Orthodox, and Jewish readings; present disagreements in their own terms.";

const SECTIONS = [
  ["writing", "Writing"],
  ["theology", "Theology"],
  ["x", "X"],
  ["rhythm", "Rhythm"],
  ["openai", "OpenAI"],
  ["spending", "Spending"],
  ["sources", "Sources"],
  ["data", "Data"],
] as const;

/** Shows a brief "Saved" after any autosave. */
function useSavedTick() {
  const [at, setAt] = useState(0);
  useEffect(() => {
    if (!at) return;
    const t = setTimeout(() => setAt(0), 1800);
    return () => clearTimeout(t);
  }, [at]);
  return { show: !!at, tick: () => setAt(Date.now()) };
}

export function Settings({ status }: { status: any }) {
  const toast = useToast();
  const { prefs, save } = usePrefs();
  const costs = useQuery({ queryKey: ["costs"], queryFn: () => api("/api/costs") });
  const [active, setActive] = useState("writing");
  const saved = useSavedTick();

  useEffect(() => {
    if (!prefs) return;
    const id = location.hash.slice(1);
    if (id) setTimeout(() => document.getElementById(id)?.scrollIntoView(), 30);
    const obs = new IntersectionObserver(
      (entries) => {
        const vis = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (vis) setActive(vis.target.id);
      },
      { rootMargin: "-80px 0px -60% 0px" },
    );
    SECTIONS.forEach(([id]) => {
      const el = document.getElementById(id);
      if (el) obs.observe(el);
    });
    return () => obs.disconnect();
  }, [!!prefs]);

  if (!prefs) return <div className="page"><Dots label="Loading" /></div>;
  const s = (patch: any) =>
    save(patch)
      .then(saved.tick)
      .catch((e) => toast(`That didn't save: ${e.message}`, "error"));

  return (
    <div className="page wide">
      <div className="row" style={{ alignItems: "baseline" }}>
        <h1 className="page-title">Settings</h1>
        <span className="spacer" />
        {saved.show && (
          <span className="saved-tick">
            <Check className="lucide" /> Saved
          </span>
        )}
      </div>
      <div className="settings">
        <nav className="settings-nav" aria-label="Settings sections">
          {SECTIONS.map(([id, label]) => (
            <a
              key={id}
              href={`#${id}`}
              className={active === id ? "active" : ""}
              onClick={(e) => {
                e.preventDefault();
                document.getElementById(id)?.scrollIntoView({ behavior: "smooth" });
                history.replaceState(null, "", `#${id}`);
              }}
            >
              {label}
            </a>
          ))}
        </nav>

        <div>
          <section id="writing">
            <h2>Writing</h2>
            <TextSetting label="Voice" rows={3} value={prefs.voicePrinciples} onSave={(v) => s({ voicePrinciples: v })} />
            <div className="field">
              <span className="field-label">Your voice on X</span>
              <span className="field-help">X drafts learn how you write from these: style, never content.</span>
              <VoiceLibrary />
            </div>
            <TextSetting label="Phrases to avoid" help="One per line." rows={5} value={prefs.bannedPhrases.join("\n")} onSave={(v) => s({ bannedPhrases: v.split("\n").map((x) => x.trim()).filter(Boolean) })} />
          </section>

          <section id="theology">
            <h2>Theology</h2>
            <TextSetting label="Your frame" rows={4} value={prefs.theologicalFrame} placeholder={FRAME_EXAMPLE} onSave={(v) => s({ theologicalFrame: v })} />
            <Toggle title="The Nicene Creed is the floor" checked={prefs.niceneFloor} onChange={(v) => s({ niceneFloor: v })} />
            <TextSetting label="Topics that need care" help="One per line." rows={4} value={prefs.careTopics.join("\n")} onSave={(v) => s({ careTopics: v.split("\n").map((x) => x.trim()).filter(Boolean) })} />
          </section>

          <section id="x">
            <h2>X</h2>
            <div className="row wrap" style={{ gap: 14 }}>
              <BlurInput label="Handle" prefix="@" value={prefs.xHandle} placeholder="yourhandle" onSave={(v) => s({ xHandle: v.replace(/^@/, "").trim() })} />
              <BlurInput label="Display name" value={prefs.xDisplayName} placeholder="Personal Commentary" onSave={(v) => s({ xDisplayName: v })} />
            </div>
            <Toggle title="Post sources as a reply" desc="A short reply under each post naming the sources it draws on." checked={prefs.postSourceReply} onChange={(v) => s({ postSourceReply: v })} />
            <Toggle title="X Premium" desc="Allows long posts beyond 280 characters." checked={prefs.premium} onChange={(v) => s({ premium: v })} />
          </section>

          <section id="rhythm">
            <h2>Rhythm</h2>
            <div className="row wrap" style={{ gap: 14 }}>
              <BlurInput label="This week's Sunday text" value={prefs.sundayText?.ref ?? ""} placeholder="Exodus 33:12–23" onSave={(v) => s({ sundayText: v.trim() ? { ref: v.trim(), date: prefs.sundayText?.date ?? nextSunday() } : null })} />
              <label className="field" style={{ width: 180 }}>
                <span className="field-label">Sunday</span>
                <input className="input" type="date" defaultValue={prefs.sundayText?.date ?? nextSunday()} disabled={!prefs.sundayText} onBlur={(e) => prefs.sundayText && e.target.value !== prefs.sundayText.date && s({ sundayText: { ...prefs.sundayText, date: e.target.value } })} />
              </label>
            </div>
          </section>

          <section id="openai">
            <h2>OpenAI</h2>
            <KeyField name="openai_api_key" present={!!status?.keys.openai} />
          </section>

          <section id="spending">
            <h2>Spending</h2>
            {costs.data && (
              <div className="stats" style={{ marginBottom: 4 }}>
                <div><div className="stat-v">{money(costs.data.month.modelMicros)}</div><div className="stat-l">Model use this month</div></div>
                <div><div className="stat-v">{money(costs.data.month.xMicros)}</div><div className="stat-l">X this month</div></div>
              </div>
            )}
            {costs.data?.month.anthropicMicros > 0 && <p className="small muted">OpenAI: {money(costs.data.month.openaiMicros)} · earlier model use: {money(costs.data.month.anthropicMicros)}. Both count toward the monthly model cap.</p>}
            {costs.data?.month.estimatedMicros > 0 && <p className="small muted">Includes {money(costs.data.month.estimatedMicros)} in conservative estimates for requests without confirmed usage. Check OpenAI billing for final charges.</p>}
            <div className="row wrap" style={{ gap: 14 }}>
              {([["perRunUsd", "Cap per research"], ["perStudyUsd", "Cap per study"], ["monthlyOpenaiUsd", "Monthly model cap"], ["monthlyXUsd", "Monthly X cap"]] as const).map(([k, l]) => (
                <label key={k} className="field" style={{ width: 150 }}>
                  <span className="field-label">{l}</span>
                  <div style={{ position: "relative" }}>
                    <span style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", color: "var(--muted)" }}>$</span>
                    <input className="input" style={{ paddingLeft: 24 }} type="number" min={0} step={0.5} defaultValue={prefs.budgets[k]} onBlur={(e) => Number(e.target.value) !== prefs.budgets[k] && s({ budgets: { ...prefs.budgets, [k]: Number(e.target.value) } })} />
                  </div>
                </label>
              ))}
            </div>
          </section>

          <section id="sources">
            <h2>Sources</h2>
            <Voices />
          </section>

          <section id="data">
            <h2>Data</h2>
            <div className="data-rows" style={{ marginBottom: 20 }}>
              <div className="data-row">
                <div className="what">
                  <b>Cloud sync is off</b>
                  <span>Studies and research stay on this Mac. Nothing is synced to a cloud service.</span>
                </div>
              </div>
              <div className="data-row">
                <div className="what">
                  <b>Private studies</b>
                  <span>Your thoughts, saved findings, selections, and draft revisions belong to your study. Download complete study data from its menu for a private copy.</span>
                </div>
              </div>
              <div className="data-row">
                <div className="what">
                  <b>Reusable research</b>
                  <span>New passage research leaves out your thoughts and writing. Open a study brief → Reusable research to inspect its content, evidence, and source rights before approving a local download. Older research stays private.</span>
                </div>
              </div>
            </div>
            <RecordsSection />
            <DatasetsSection />
          </section>
        </div>
      </div>
    </div>
  );
}

function nextSunday() {
  const d = new Date();
  d.setDate(d.getDate() + ((7 - d.getDay()) % 7 || 7));
  return d.toISOString().slice(0, 10);
}

export function TextSetting({ label, help, value, onSave, rows = 4, placeholder }: { label: string; help?: string; value: string; onSave: (v: string) => void; rows?: number; placeholder?: string }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {help && <span className="field-help">{help}</span>}
      <textarea className="textarea" rows={rows} value={v} placeholder={placeholder} onChange={(e) => setV(e.target.value)} onBlur={() => v !== value && onSave(v)} />
    </label>
  );
}

function BlurInput({ label, value, onSave, placeholder, prefix }: { label: string; value: string; onSave: (v: string) => void; placeholder?: string; prefix?: string }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <label className="field grow" style={{ minWidth: 200 }}>
      <span className="field-label">{label}</span>
      <div style={{ position: "relative" }}>
        {prefix && <span style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", color: "var(--muted)" }}>{prefix}</span>}
        <input className="input" style={prefix ? { paddingLeft: 26 } : undefined} value={v} placeholder={placeholder} onChange={(e) => setV(e.target.value)} onBlur={() => v !== value && onSave(v)} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />
      </div>
    </label>
  );
}

function Toggle({ title, desc, checked, onChange }: { title: string; desc?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="setting-row" style={{ cursor: "pointer" }}>
      <div>
        <div className="t">{title}</div>
        {desc && <div className="d">{desc}</div>}
      </div>
      <input className="switch" type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

export function KeyField({ name, present }: { name: string; present: boolean }) {
  const toast = useToast();
  const [value, setValue] = useState("");
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [replacing, setReplacing] = useState(!present);
  useEffect(() => setReplacing(!present), [present]);
  const test = async () => {
    setBusy(true);
    try {
      setResult(await api(`/api/keys/${name}/test`, { method: "POST" }));
    } catch (e: any) {
      toast(e.message, "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stack" style={{ gap: 10 }}>
      {!replacing ? (
        <div className="setting-row">
          <div>
            <div className="t row" style={{ gap: 6 }}>
              <Check className="lucide" style={{ color: "var(--good)", width: 16, height: 16 }} /> OpenAI key saved in your Keychain
            </div>
          </div>
          <div className="row">
            <button className="btn sm ghost" onClick={test} disabled={busy}>{busy ? <Dots label="Testing" /> : "Test"}</button>
            <button className="btn sm secondary" onClick={() => setReplacing(true)}>Replace</button>
          </div>
        </div>
      ) : (
        <form
          className="row wrap"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              await api(`/api/keys/${name}`, { method: "PUT", body: { value: value.trim() } });
              setValue("");
              queryClient.invalidateQueries({ queryKey: ["status"] });
              setResult(await api(`/api/keys/${name}/test`, { method: "POST" }));
            } catch (er: any) {
              toast(er.message, "error");
            } finally {
              setBusy(false);
            }
          }}
        >
          <input className="input grow" type="password" autoComplete="off" spellCheck={false} placeholder="Paste your OpenAI API key" value={value} onChange={(e) => setValue(e.target.value)} style={{ minWidth: 240 }} aria-label="OpenAI API key" />
          <button className="btn primary" type="submit" disabled={!value.trim() || busy}>{busy ? <Dots label="Saving" /> : "Save"}</button>
          {present && <button className="btn ghost" type="button" onClick={() => setReplacing(false)}>Cancel</button>}
        </form>
      )}
      {!present && (
        <span className="small muted">
          Create one at <a className="link" href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer">platform.openai.com</a>. It is kept in the macOS Keychain and sent only to OpenAI. API billing is separate from ChatGPT.
        </span>
      )}
      {result && (
        <span className="small row" style={{ color: result.ok ? "var(--good)" : "var(--bad)", gap: 6 }}>
          {result.ok ? <Check className="lucide" style={{ width: 15 }} /> : <X className="lucide" style={{ width: 15 }} />} {result.message}
        </span>
      )}
    </div>
  );
}

export function DatasetsSection({ onlyMissing = false }: { onlyMissing?: boolean }) {
  const q = useQuery({ queryKey: ["datasets"], queryFn: () => api("/api/datasets") });
  useServerEvent("datasets", (data) => queryClient.setQueryData(["datasets"], data));
  const rows = (q.data ?? []).filter((ds: any) => !onlyMissing || !ds.present || ds.progress);
  return (
    <div>
      {rows.map((ds: any) => {
        const pct = ds.progress?.total ? Math.round((ds.progress.received / ds.progress.total) * 100) : null;
        const downloading = !!ds.progress && !ds.progress.error;
        return (
          <div key={ds.id} className="dataset">
            <div>
              <div className="name">
                {ds.name}
                {ds.present && !downloading && <Check className="lucide" style={{ color: "var(--good)", width: 15, height: 15 }} aria-label="Downloaded" />}
              </div>
              <div className="what">
                {ds.license} · {ds.present ? `${(ds.size / 1e6).toFixed(0)} MB` : `about ${ds.approx}`}
                {ds.required && !ds.present ? " · needed to read" : ""}
              </div>
              {ds.progress?.error && <div className="small" style={{ color: "var(--bad)" }}>{ds.progress.error} Check your connection and try again.</div>}
            </div>
            <button className={`btn sm ${ds.present ? "ghost" : "primary"}`} disabled={downloading} onClick={() => api(`/api/datasets/${ds.id}/download`, { method: "POST" })}>
              {downloading ? `${pct ?? 0}%` : ds.present ? "Update" : ds.progress?.error ? "Try again" : "Download"}
            </button>
            {downloading && (
              <div className="bar"><span style={{ width: `${pct ?? 3}%` }} /></div>
            )}
          </div>
        );
      })}
    </div>
  );
}

const TRAD: Record<string, string> = { patristic_east: "Church Fathers, East", patristic_west: "Church Fathers, West", medieval: "Medieval", reformation: "Reformation", post_reformation: "Post-Reformation", evangelical: "Evangelical", modern: "Modern", jewish: "Jewish" };

function Voices() {
  const toast = useToast();
  const authors = useQuery({ queryKey: ["authors"], queryFn: () => api<any[]>("/api/authors") });
  const domains = useQuery({ queryKey: ["domains"], queryFn: () => api<any[]>("/api/domains") });
  const [showOthers, setShowOthers] = useState(false);
  const [showSites, setShowSites] = useState(false);
  const reload = () => queryClient.invalidateQueries({ queryKey: ["authors"] });
  const preferred = (authors.data ?? []).filter((a) => a.is_preferred).sort((a, b) => (a.preference_rank ?? 99) - (b.preference_rank ?? 99));
  const others = (authors.data ?? []).filter((a) => !a.is_preferred);

  const guard = (p: Promise<any>) => p.then(reload).catch((e) => toast(e.message, "error"));
  const move = (i: number, dir: -1 | 1) => {
    const list = [...preferred];
    const j = i + dir;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    guard(Promise.all(list.map((a, k) => api(`/api/authors/${a.id}`, { method: "PATCH", body: { preference_rank: k + 1 } }))));
  };
  const toggle = (a: any) => guard(api(`/api/authors/${a.id}`, { method: "PATCH", body: { is_preferred: !a.is_preferred, preference_rank: a.is_preferred ? null : preferred.length + 1 } }));

  return (
    <>
      <div>
        <div className="voice scripture">
          <span className="n" aria-hidden="true">✦</span>
          <div className="grow">
            <div className="who">Scripture</div>
            <div className="what">The final authority. Every voice below is weighed against it.</div>
          </div>
        </div>
        {preferred.map((a, i) => (
          <div key={a.id} className="voice">
            <span className="n">{i + 1}</span>
            <div className="grow">
              <div className="who">{a.display_name}</div>
              <div className="what">{TRAD[a.tradition] ?? a.tradition}{a.care_note ? ` · ${a.care_note}` : ""}</div>
            </div>
            <button className="icon-btn" aria-label={`Move ${a.display_name} up`} onClick={() => move(i, -1)} disabled={i === 0}><ArrowUp className="lucide" style={{ width: 16 }} /></button>
            <button className="icon-btn" aria-label={`Move ${a.display_name} down`} onClick={() => move(i, 1)} disabled={i === preferred.length - 1}><ArrowDown className="lucide" style={{ width: 16 }} /></button>
            <button className="icon-btn" aria-label={`Remove ${a.display_name} from preferred`} title="Remove from preferred" onClick={() => toggle(a)}><X className="lucide" style={{ width: 16 }} /></button>
          </div>
        ))}
      </div>
      {others.length > 0 && (
        <div>
          <button className="text-btn" onClick={() => setShowOthers((x) => !x)} aria-expanded={showOthers}>
            {showOthers ? "Hide" : "Add"} other voices ({others.length}) {showOthers ? "▴" : "▾"}
          </button>
          {showOthers && (
            <div style={{ marginTop: 8 }}>
              {others.map((a) => (
                <div key={a.id} className="voice">
                  <div className="grow">
                    <div className="who">{a.display_name}</div>
                    <div className="what">{a.full_identity}</div>
                  </div>
                  <button className="btn sm secondary" onClick={() => toggle(a)}>Prefer</button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {domains.data && domains.data.length > 0 && (
        <div className="field">
          <button className="text-btn" style={{ alignSelf: "flex-start" }} onClick={() => setShowSites((x) => !x)} aria-expanded={showSites}>
            Websites {showSites ? "▴" : "▾"}
          </button>
          {showSites && <div className="domains">
            {domains.data.map((d) => (
              <span key={d.host} className={`pill ${d.policy === "primary" ? "good" : ""}`} style={d.policy === "blocked" ? { textDecoration: "line-through" } : undefined} title={d.notes ?? d.policy}>
                {d.host}
              </span>
            ))}
          </div>}
        </div>
      )}
      <p className="tiny faint" style={{ margin: 0 }}>
        Cross-references: openbible.info. Commentaries: Bible Hub and Enduring Word. Preachers: their own sites, found by search. Church Fathers: Historical Christian Faith. Jewish commentary: Sefaria.
      </p>
    </>
  );
}

function RecordsSection() {
  const toast = useToast();
  const q = useQuery({ queryKey: ["records"], queryFn: () => api("/api/records") });
  const [busy, setBusy] = useState<null | "backup" | "rebuild">(null);
  const d = q.data;
  const last = d?.backups?.[0];
  const run = async (kind: "backup" | "rebuild") => {
    setBusy(kind);
    try {
      if (kind === "backup") {
        await api("/api/backups", { method: "POST" });
        toast("Backed up.");
      } else {
        const r = await api("/api/records/rebuild", { method: "POST" });
        toast(`Wrote ${r.written} file${r.written === 1 ? "" : "s"}.`);
      }
      q.refetch();
    } catch (e: any) {
      toast(e.message, "error");
    } finally {
      setBusy(null);
    }
  };
  const open = (which: "notes" | "backups") => api("/api/records/reveal", { method: "POST", body: { which } }).catch((e) => toast(e.message, "error"));
  if (!d) return null;
  return (
    <div className="data-rows">
      <div className="data-row">
        <div className="what">
          <b>Your notes</b>
          <span>{d.notesWhere} · {d.count} {d.count === 1 ? "study" : "studies"}, one Markdown file each, by book</span>
        </div>
        <button className="btn sm ghost" onClick={() => open("notes")}>Open folder</button>
        <button className="btn sm secondary" onClick={() => run("rebuild")} disabled={!!busy}>{busy === "rebuild" ? <Dots label="Writing" /> : "Write all files"}</button>
      </div>
      <div className="data-row">
        <div className="what">
          <b>Backups</b>
          <span>
            {last ? `Last backup ${fmtDate(last.at)} · ${(last.bytes / 1_048_576).toFixed(1)} MB` : "No backup yet"} · one a day, the last 14 kept in {d.backupDir}
          </span>
        </div>
        <button className="btn sm ghost" onClick={() => open("backups")}>Open folder</button>
        <button className="btn sm secondary" onClick={() => run("backup")} disabled={!!busy}>{busy === "backup" ? <Dots label="Backing up" /> : "Back up now"}</button>
      </div>
    </div>
  );
}
