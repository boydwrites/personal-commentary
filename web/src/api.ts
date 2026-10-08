import { QueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { flushPendingChanges } from "./desktop";

const capability = document.querySelector<HTMLMetaElement>('meta[name="app-capability"]')?.content ?? "";

export class ApiError extends Error {
  status: number;
  data: any;
  constructor(status: number, message: string, data: any) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = opts.method ?? "GET";
  const res = await fetch(path, {
    method,
    headers: { ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}), ...(method !== "GET" ? { "X-App-Capability": capability } : {}) },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) throw new ApiError(res.status, data?.error ?? `Request failed (${res.status})`, data);
  return data as T;
}

export const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1, staleTime: 5_000 } },
});

// ---- server-sent events ----
type Handler = (data: any) => void;
const handlers = new Map<string, Set<Handler>>();
let source: EventSource | null = null;
let online = true;
const onlineSubs = new Set<() => void>();
function setOnline(v: boolean) {
  if (online === v) return;
  online = v;
  onlineSubs.forEach((f) => f());
}
function ensureSource() {
  if (source) return;
  source = new EventSource("/api/events");
  source.onopen = () => setOnline(true);
  source.onerror = () => setOnline(false);
  for (const ev of ["run", "cost", "datasets"]) {
    source.addEventListener(ev, (e) => {
      const data = JSON.parse((e as MessageEvent).data);
      handlers.get(ev)?.forEach((h) => h(data));
    });
  }
}
export function useServerEvent(event: string, handler: Handler) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    ensureSource();
    const h: Handler = (d) => ref.current(d);
    if (!handlers.has(event)) handlers.set(event, new Set());
    handlers.get(event)!.add(h);
    return () => {
      handlers.get(event)!.delete(h);
    };
  }, [event]);
}
export function useServerOnline() {
  return useSyncExternalStore(
    (f) => {
      ensureSource();
      onlineSubs.add(f);
      return () => onlineSubs.delete(f);
    },
    () => online,
  );
}

// ---- tiny router ----
const routeSubs = new Set<() => void>();
let renderedLocation = location.pathname + location.search + location.hash;
let navigationRequest = 0;
window.addEventListener("popstate", async () => {
  const request = ++navigationRequest;
  const saved = await flushPendingChanges();
  if (request !== navigationRequest) return;
  if (!saved) {
    history.pushState(null, "", renderedLocation);
    return;
  }
  renderedLocation = location.pathname + location.search + location.hash;
  routeSubs.forEach((f) => f());
});
export async function navigate(to: string, replace = false) {
  if (to === location.pathname + location.search) return;
  const request = ++navigationRequest;
  if (!(await flushPendingChanges())) return;
  if (request !== navigationRequest) return;
  if (replace) history.replaceState(null, "", to);
  else history.pushState(null, "", to);
  renderedLocation = location.pathname + location.search + location.hash;
  routeSubs.forEach((f) => f());
  if (!to.includes("#")) window.scrollTo(0, 0);
}
export function usePath() {
  return useSyncExternalStore(
    (f) => {
      routeSubs.add(f);
      return () => routeSubs.delete(f);
    },
    () => location.pathname,
  );
}
/** The path and query, for screens whose state lives in the query (Library's tab). */
export function useLocation() {
  return useSyncExternalStore(
    (f) => {
      routeSubs.add(f);
      return () => routeSubs.delete(f);
    },
    () => location.pathname + location.search,
  );
}

export const money = (micros: number) => `$${(micros / 1_000_000).toFixed(micros < 10_000_000 ? 2 : 0)}`;
export const fmtDate = (iso: string) => new Date(iso.length === 10 ? iso + "T12:00:00" : iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

/** "Today", "Yesterday", "Mon", or "Sep 14" — dates as a person would say them. */
export function relDate(iso: string) {
  const d = new Date(iso.length === 10 ? iso + "T12:00:00" : iso);
  const today = new Date();
  const days = Math.round((new Date(today.toDateString()).getTime() - new Date(d.toDateString()).getTime()) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days > 1 && days < 7) return d.toLocaleDateString(undefined, { weekday: "long" });
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(d.getFullYear() !== today.getFullYear() ? { year: "numeric" } : {}) });
}

/** "today", "yesterday", "on Monday", "on Sep 14" — for use mid-sentence. */
export function whenPhrase(iso: string) {
  const r = relDate(iso);
  return r === "Today" || r === "Yesterday" ? r.toLowerCase() : `on ${r}`;
}
