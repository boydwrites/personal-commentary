// Every billable call writes the ledger; caps stop work before they're exceeded. Money is integer micro-dollars.
import type { DB } from "./db.ts";
import { uuidv7, nowIso } from "./db.ts";
import { getPrefs } from "./prefs.ts";
import type { Model } from "./config.ts";
import { emit } from "./events.ts";

// Standard processing, verified October 2, 2026: https://developers.openai.com/api/docs/pricing
// Per-token micro-dollars equal the published per-million-token dollar prices.
export const MODEL_PRICES = {
  "gpt-6-luna": { input: 0.1, cached: 0.01, cacheWrite: 0.125, output: 0.5 },
  "gpt-6.1-sol": { input: 2, cached: 0.1, cacheWrite: 2.5, output: 10 },
} satisfies Record<Model, { input: number; cached: number; cacheWrite: number; output: number }>;

/** Web search tool calls: $10 per 1,000, plus the search content billed as input tokens. */
export const WEB_SEARCH_CALL_MICROS = 10_000;
/** Search results enter the context as input; reserve for a few searches' worth. */
export const WEB_SEARCH_INPUT_TOKENS = 30_000;

export const usd = (micros: number) => micros / 1_000_000;
export const micros = (dollars: number) => Math.round(dollars * 1_000_000);

export interface Usage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  input_tokens_details?: { cached_tokens?: number | null; cache_write_tokens?: number | null } | null;
}

export function costOfUsage(u: Usage, model: Model): number {
  const p = MODEL_PRICES[model];
  const input = u.input_tokens ?? 0;
  const cached = u.input_tokens_details?.cached_tokens ?? 0;
  const written = u.input_tokens_details?.cache_write_tokens ?? 0;
  const long = input > 272_000;
  // Read/write counts are subsets of input_tokens, not additional input.
  return Math.ceil((Math.max(0, input - cached - written) * p.input + cached * p.cached + written * p.cacheWrite) * (long ? 2 : 1) +
    (u.output_tokens ?? 0) * p.output * (long ? 1.5 : 1));
}

export function recordCost(db: DB, row: { vendor: "anthropic" | "openai" | "x"; category: string; refTable?: string; refId?: string; studyId?: string | null; runId?: string | null; units: number; usdMicros: number }) {
  if (!row.usdMicros) return;
  db.prepare("INSERT INTO cost_ledger (id, occurred_at, vendor, category, ref_table, ref_id, study_id, run_id, units, usd_micros) VALUES (?,?,?,?,?,?,?,?,?,?)").run(
    uuidv7(), nowIso(), row.vendor, row.category, row.refTable ?? null, row.refId ?? null, row.studyId ?? null, row.runId ?? null, row.units, row.usdMicros,
  );
  emit("cost", monthTotals(db));
}

function monthStart(): string {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString();
}

export function monthTotals(db: DB) {
  const rows = db.prepare("SELECT vendor, SUM(usd_micros) s FROM cost_ledger WHERE occurred_at >= ? GROUP BY vendor").all(monthStart()) as { vendor: string; s: number }[];
  const anthropic = rows.find((r) => r.vendor === "anthropic")?.s ?? 0;
  const openai = rows.find((r) => r.vendor === "openai")?.s ?? 0;
  const x = rows.find((r) => r.vendor === "x")?.s ?? 0;
  const estimated = (db.prepare("SELECT COALESCE(SUM(usd_micros),0) s FROM cost_ledger WHERE occurred_at >= ? AND category = 'estimated_tokens'").get(monthStart()) as { s: number }).s;
  return { openaiMicros: openai, anthropicMicros: anthropic, modelMicros: openai + anthropic, xMicros: x, totalMicros: openai + anthropic + x, estimatedMicros: estimated };
}

export function spentOn(db: DB, field: "study_id" | "run_id", id: string): number {
  return (db.prepare(`SELECT COALESCE(SUM(usd_micros),0) s FROM cost_ledger WHERE ${field} = ?`).get(id) as any).s;
}

export class BudgetError extends Error {
  cap: string;
  constructor(cap: string, message: string) {
    super(message);
    this.cap = cap;
  }
}

/** Conservative bound: UTF-8 request bytes, schema included, plus framing; charge all input as cache writes. */
export function estimateCall(inputBytes: number, maxTokens: number, model: Model): number {
  const input = inputBytes + 2048;
  const p = MODEL_PRICES[model];
  return Math.ceil(input * p.cacheWrite * (input > 272_000 ? 2 : 1) + maxTokens * p.output * (input > 272_000 ? 1.5 : 1));
}

type BudgetContext = { studyId?: string | null; runId?: string | null };
const pending = new WeakMap<DB, Set<BudgetContext & { estimate: number }>>();

export function checkModelBudget(db: DB, est: number, ctx: BudgetContext) {
  const b = getPrefs(db).budgets;
  const active = [...(pending.get(db) ?? [])];
  const reserved = (field?: "studyId" | "runId", id?: string) => active.reduce((sum, r) => sum + (!field || r[field] === id ? r.estimate : 0), 0);
  const month = monthTotals(db).modelMicros;
  if (month + reserved() + est > micros(b.monthlyOpenaiUsd)) {
    throw new BudgetError("monthly", `This month's model spending cap ($${b.monthlyOpenaiUsd.toFixed(2)}) would be exceeded. Your notes are saved. Raise it in Settings → Spending, or wait for next month.`);
  }
  if (ctx.runId && spentOn(db, "run_id", ctx.runId) + reserved("runId", ctx.runId) + est > micros(b.perRunUsd)) {
    throw new BudgetError("run", `The per-run cap ($${b.perRunUsd.toFixed(2)}) would be exceeded. Your notes and sources are saved. Raise it in Settings → Spending.`);
  }
  if (ctx.studyId && spentOn(db, "study_id", ctx.studyId) + reserved("studyId", ctx.studyId) + est > micros(b.perStudyUsd)) {
    throw new BudgetError("study", `This study's cap ($${b.perStudyUsd.toFixed(2)}) would be exceeded. Your notes are saved. Raise it in Settings → Spending.`);
  }
}

/** Prevent concurrent calls from spending the same remaining budget. Release after recording the charge. */
export function reserveModelBudget(db: DB, estimate: number, ctx: BudgetContext): () => void {
  checkModelBudget(db, estimate, ctx);
  const active = pending.get(db) ?? new Set();
  pending.set(db, active);
  const reservation = { ...ctx, estimate };
  active.add(reservation);
  return () => { active.delete(reservation); };
}
