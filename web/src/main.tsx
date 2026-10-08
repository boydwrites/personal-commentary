import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { BarChart3, Settings as SettingsIcon } from "lucide-react";
import "./styles.css";
import "./desktop";
import { api, queryClient, useLocation, useServerEvent, useServerOnline, navigate } from "./api";
import { Link, ToastProvider } from "./components/ui";
import { Wordmark } from "./components/Logo";
import { rememberAppPath } from "./backTo";
import { Today } from "./screens/Today";
import { Study, STAGES } from "./screens/Study";
import { Library } from "./screens/Library";
import { Insights } from "./screens/Insights";
import { Settings } from "./screens/Settings";
import { Setup } from "./screens/Setup";
import type { Stage } from "./study/StudyHeader";

const NAV = [
  { to: "/", label: "Today", key: "1", match: (p: string) => p === "/" },
  { to: "/library", label: "Library", key: "2", match: (p: string) => p.startsWith("/library") },
];

/** The bar on every page outside a study: where you are, and the two places you go. */
function AppHeader({ path }: { path: string }) {
  return (
    <header className="topbar">
      <Link to="/" aria-label="Personal Commentary — Today" className="brand">
        <Wordmark />
      </Link>
      <nav className="nav" aria-label="Main">
        {NAV.map((n) => (
          <Link key={n.to} to={n.to} className={n.match(path) ? "active" : ""} aria-current={n.match(path) ? "page" : undefined} title={`${n.label}  ⌘${n.key}`}>
            {n.label}
          </Link>
        ))}
      </nav>
      <div className="topbar-right">
        <Link to="/insights" className={`icon-btn ${path.startsWith("/insights") ? "active" : ""}`} aria-label="Insights" title="Insights">
          <BarChart3 className="lucide" />
        </Link>
        <Link to="/settings" className={`icon-btn ${path.startsWith("/settings") ? "active" : ""}`} aria-label="Settings" title="Settings  ⌘,">
          <SettingsIcon className="lucide" />
        </Link>
      </div>
    </header>
  );
}

function App() {
  const loc = useLocation();
  const path = loc.split("?")[0];
  const online = useServerOnline();
  const status = useQuery({ queryKey: ["status"], queryFn: () => api("/api/status") });
  useServerEvent("datasets", () => queryClient.invalidateQueries({ queryKey: ["status"] }));
  useEffect(() => rememberAppPath(loc), [loc]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
      const go: Record<string, string> = { k: "/library?focus=1", "1": "/", "2": "/library", "3": "/library?tab=later", ",": "/settings" };
      const to = go[e.key];
      if (!to) return;
      e.preventDefault();
      void navigate(to);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Old addresses still land somewhere sensible.
  useEffect(() => {
    if (path === "/preferences") void navigate("/settings", true);
    if (path === "/sources") void navigate("/settings#sources", true);
    if (path === "/later") void navigate("/library?tab=later", true);
  }, [path]);

  if (status.isLoading) return null;
  if (status.data && !status.data.onboarded) return <Setup status={status.data} />;

  const offline = !online && <div className="offline" role="alert">Can't reach Personal Commentary on this Mac. Your saved studies are safe, but new changes may not save. Reopen the app to reconnect.</div>;
  const studyMatch = path.match(/^\/study\/([\w-]+)(?:\/(\w+))?/);
  if (studyMatch) {
    const stage = (STAGES as string[]).includes(studyMatch[2] ?? "") ? (studyMatch[2] as Stage) : null;
    return (
      <>
        {offline}
        <Study key={studyMatch[1]} id={studyMatch[1]} stage={stage} />
      </>
    );
  }
  let screen;
  if (path.startsWith("/library")) screen = <Library />;
  else if (path.startsWith("/insights")) screen = <Insights />;
  else if (path.startsWith("/settings")) screen = <Settings status={status.data} />;
  else screen = <Today />;

  return (
    <>
      {offline}
      <AppHeader path={path} />
      <main className="screen">{screen}</main>
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <App />
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
);
