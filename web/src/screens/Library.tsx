import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FileText, Search } from "lucide-react";
import { api, navigate, relDate, useLocation } from "../api";
import { Link, Empty, Dots } from "../components/ui";
import { LaterList, useLater } from "../components/LaterList";
import { WRITING_LABELS, type WritingFormat } from "../../../shared/writing";

/** What a study's status means to you. */
export const STATUS_WORD: Record<string, string> = { open: "In progress", saved: "Finished", published: "Posted", archived: "Archived" };

function Snip({ s }: { s: string }) {
  const parts = s.split(/\[\[|\]\]/);
  return <>{parts.map((p, i) => (i % 2 ? <b key={i}>{p}</b> : <span key={i}>{p}</span>))}</>;
}

const FILTERS = [
  ["", "All"],
  ["open", "In progress"],
  ["saved", "Finished"],
  ["published", "Posted"],
  ["archived", "Archived"],
] as const;

/** Where a study got to, in a few words: the piece it holds, or how far it went. */
export function describe(r: any) {
  if (r.excerptKind === "posted") return "Posted to X";
  if (r.excerptKind === "post") {
    const format = r.excerptFormat ?? r.format;
    const label = WRITING_LABELS[format as WritingFormat] ?? "Piece";
    return `${label}${format === "thread" && r.partCount > 1 ? ` · ${r.partCount} parts` : ""}`;
  }
  if (r.excerptKind === "note") return "Notes";
  return r.researched ? "Researched" : "Reading";
}

export function StudyRow({ r }: { r: any }) {
  return (
    <Link to={`/study/${r.id}`} className="lib-row">
      <div className="lib-top">
        <span className="lib-ref">{r.display_ref}</span>
        {r.title && <span className="lib-title">{r.title}</span>}
        <span className="lib-date">{relDate(r.created_local_date)}</span>
      </div>
      {r.excerpt && !r.snippets?.length && <div className={`lib-line ${r.excerptKind === "note" ? "note" : ""}`}>{r.excerpt}</div>}
      {r.snippets?.map((s: string, i: number) => <div key={i} className="lib-snip"><Snip s={s} /></div>)}
      <div className="lib-sub">
        <span className={`status-chip ${r.status}`}>{STATUS_WORD[r.status] ?? r.status}</span>
        <span>{describe(r)}</span>
        {r.hasRecord && (
          <span className="lib-file" title="A readable Markdown copy is saved in Documents">
            <FileText className="lucide" aria-hidden="true" /> File saved
          </span>
        )}
      </div>
    </Link>
  );
}

export function Library() {
  const loc = useLocation();
  const tab = new URLSearchParams(loc.split("?")[1] ?? "").get("tab") === "later" ? "later" : "studies";
  const later = useLater();
  const laterCount = (later.data ?? []).filter((it) => !it.used_in_study_id).length;
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [status, setStatus] = useState("");
  const [byBook, setByBook] = useState(() => {
    try {
      return localStorage.getItem("commentary.libraryByBook") === "1";
    } catch {
      return false;
    }
  });
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 200);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => {
    if (loc.includes("focus")) input.current?.focus();
  }, [loc]);
  useEffect(() => {
    try {
      localStorage.setItem("commentary.libraryByBook", byBook ? "1" : "0");
    } catch {
      /* a convenience only */
    }
  }, [byBook]);
  const list = useQuery({ queryKey: ["studies", debounced, status], queryFn: () => api<any[]>(`/api/studies?${new URLSearchParams({ ...(debounced ? { q: debounced } : {}), ...(status ? { status } : {}) })}`), placeholderData: (prev) => prev, enabled: tab === "studies" });
  // "All" hides archived studies; the Archived filter shows them.
  const rows: any[] = (list.data ?? []).filter((r) => status === "archived" || r.status !== "archived");
  const grouped = useMemo(() => {
    const m = new Map<string, any[]>();
    for (const r of [...rows].sort((a, b) => a.bookIndex - b.bookIndex || a.ref_start_ord - b.ref_start_ord)) {
      const book = r.display_ref.replace(/\s\d.*$/, "");
      if (!m.has(book)) m.set(book, []);
      m.get(book)!.push(r);
    }
    return [...m];
  }, [rows]);

  return (
    <div className="page">
      <header className="page-head">
        <h1 className="page-title">Library</h1>
        <div className="tabs" role="tablist" aria-label="Library">
          <button role="tab" aria-selected={tab === "studies"} onClick={() => void navigate("/library", true)}>Studies</button>
          <button role="tab" aria-selected={tab === "later"} onClick={() => void navigate("/library?tab=later", true)}>
            Saved for later{laterCount > 0 && <span className="badge">{laterCount}</span>}
          </button>
        </div>
      </header>

      {tab === "later" ? (
        <LaterList />
      ) : (
        <>
          <div className="search">
            <Search className="lucide" aria-hidden="true" />
            <input ref={input} placeholder="Search notes, highlights, research, and writing — or a passage" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search the library" onKeyDown={(e) => e.key === "Escape" && setQ("")} />
            {!q && <span className="kbd" aria-hidden="true">⌘K</span>}
          </div>
          <div className="filters">
            <div className="seg" role="group" aria-label="Status">
              {FILTERS.map(([v, l]) => (
                <button key={v} aria-pressed={status === v} onClick={() => setStatus(v)}>{l}</button>
              ))}
            </div>
            <span className="spacer" />
            <button className="btn sm ghost" onClick={() => setByBook((x) => !x)}>{byBook ? "Newest first" : "By book"}</button>
          </div>
          {list.isLoading && <Dots label="Loading" />}
          {list.isError && <div role="alert" className="small muted"><p>The library couldn't load. Your studies are still on this Mac. Try loading them again.</p><button className="btn ghost" onClick={() => list.refetch()}>Try again</button></div>}
          {!list.isLoading && !list.isError && rows.length === 0 && (
            <Empty title={debounced ? "Nothing matches that." : status ? `No studies ${(STATUS_WORD[status] ?? status).toLowerCase()}.` : "Nothing here yet."}>
              {debounced ? "Try fewer words, or a passage like “Exodus 33”." : !status && <>Every study you begin on <Link className="link" to="/">Today</Link> is kept here.</>}
            </Empty>
          )}
          {!byBook && <div className="lib-list">{rows.map((r) => <StudyRow key={r.id} r={r} />)}</div>}
          {byBook &&
            grouped.map(([book, rs]) => (
              <section key={book} className="lib-book">
                <h2>{book}</h2>
                <div className="lib-list">{rs.map((r) => <StudyRow key={r.id} r={r} />)}</div>
              </section>
            ))}
        </>
      )}
    </div>
  );
}
