import { useQuery } from "@tanstack/react-query";
import { api, money, relDate } from "../api";
import { Dots } from "../components/ui";

const key = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function Heatmap({ byDay }: { byDay: Record<string, number> }) {
  const end = new Date();
  const start = new Date(end);
  start.setDate(end.getDate() - 7 * 17 - end.getDay() + 1); // whole weeks, ending this week
  const days: { date: string; n: number }[] = [];
  for (const d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) days.push({ date: key(d), n: byDay[key(d)] ?? 0 });
  const today = key(end);
  return (
    <div className="heat" role="img" aria-label="Studies per day over the last four months">
      {days.map((d) => (
        <span key={d.date} className={`${d.n >= 2 ? "l2" : d.n === 1 ? "l1" : ""} ${d.date === today ? "is-today" : ""}`} title={`${relDate(d.date)}: ${d.n ? `${d.n} stud${d.n === 1 ? "y" : "ies"}` : "no study"}`} />
      ))}
    </div>
  );
}

export function Insights() {
  const q = useQuery({ queryKey: ["insights"], queryFn: () => api("/api/insights") });
  const costs = useQuery({ queryKey: ["costs"], queryFn: () => api("/api/costs") });
  const d = q.data;
  if (!d) return <div className="page"><Dots label="Loading" /></div>;
  const p = d.practice;
  const mains = d.posts.filter((x: any) => x.role === "main");

  return (
    <div className="page">
      <h1 className="page-title">Insights</h1>

      <div className="stats">
        <div><div className="stat-v">{p.studiesCompleted}</div><div className="stat-l">{p.studiesCompleted === 1 ? "study" : "studies"}</div></div>
        <div><div className="stat-v">{mains.length}</div><div className="stat-l">{mains.length === 1 ? "post" : "posts"}</div></div>
        <div><div className="stat-v">{p.medianHumanMinutes != null ? Math.round(p.medianHumanMinutes) : "—"}</div><div className="stat-l">minutes, typical study</div></div>
        <div><div className="stat-v">{money(p.costThisMonthMicros)}</div><div className="stat-l">spent this month{p.costPerPostMicros != null ? ` · ${money(p.costPerPostMicros)}/post` : ""}</div></div>
      </div>
      {costs.data?.month.estimatedMicros > 0 && <p className="small muted">This month's spending includes {money(costs.data.month.estimatedMicros)} in conservative estimates for requests without confirmed usage. Check OpenAI billing for final charges.</p>}
      <Heatmap byDay={p.byDay} />
      {p.returnsToPriorWork > 0 && <p className="small muted" style={{ marginTop: 14 }}>You built on earlier work {p.returnsToPriorWork} time{p.returnsToPriorWork === 1 ? "" : "s"}.</p>}

      {mains.length > 0 && <h2 className="section-title">Posts</h2>}
      {mains.length > 0 && (
        <div>
          {mains.map((x: any) => (
            <a key={x.id} className="post-row" href={x.x_url} target="_blank" rel="noreferrer noopener">
              <span className="list-ref" style={{ fontSize: 15 }}>{x.display_ref}</span>
              <span className="t grow">{x.text.split("\n")[0]}</span>
              <span className="list-meta">{relDate(x.posted_at)}</span>
            </a>
          ))}
        </div>
      )}

    </div>
  );
}
