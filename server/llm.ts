// One wrapper for every model call: OpenAI Responses, stage-specific models, strict output, and capped costs.
import type { DB } from "./db.ts";
import { uuidv7, nowIso } from "./db.ts";
import { RESEARCH_MODEL, WRITING_MODEL, type Model } from "./config.ts";
import { getSecret } from "./secrets.ts";
import { reserveModelBudget, costOfUsage, estimateCall, recordCost, MODEL_PRICES, WEB_SEARCH_CALL_MICROS, WEB_SEARCH_INPUT_TOKENS, type Usage } from "./costs.ts";
import { fetchOpenai, FetchError } from "./fetcher.ts";
import { log } from "./log.ts";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export type Stage = "connections" | "brief_scripture" | "brief_background" | "brief_voices" | "angle" | "allusions" | "draft" | "sharpen" | "review" | "translate" | "discover" | "title";

/** research and starting help on the research model; drafting, sharpening, and review on the writing model. */
export function modelForStage(stage: Stage): Model {
  return stage === "draft" || stage === "sharpen" || stage === "review" ? WRITING_MODEL : RESEARCH_MODEL;
}

export class ModelError extends Error {
  kind: "no_key" | "refusal" | "truncated" | "invalid_output" | "api" | "auth" | "rate_limit" | "overloaded" | "connection";
  /** Technical detail for the log and llm_calls; never shown in the interface. */
  detail: string | null;
  constructor(kind: ModelError["kind"], message: string, detail: string | null = null) {
    super(message);
    this.kind = kind;
    this.detail = detail;
  }
}

function apiKey(): string {
  const key = getSecret("openai_api_key");
  if (!key) throw new ModelError("no_key", "An OpenAI API key hasn't been added. Reading and saving notes still work. Add the key in Settings → OpenAI to use research, drafting, and checks.");
  return key;
}

export interface StructuredCall {
  db: DB;
  stage: Stage;
  promptVersion: string;
  system: string;
  user: string;
  schema: Record<string, unknown>;
  effort: Effort;
  maxTokens: number;
  studyId?: string | null;
  runId?: string | null;
  signal?: AbortSignal;
  /** Restrict web search to these sites. Omit for a call without tools. */
  webSearchDomains?: string[];
  /** Upper bound on searches, used for the budget reservation. */
  maxSearches?: number;
}

interface ModelResponse {
  id?: string;
  model?: string;
  status?: string;
  output?: { type: string; content?: { type: string; text?: string; refusal?: string }[] }[];
  usage?: Usage | null;
  incomplete_details?: { reason?: string } | null;
  error?: { code?: string; message?: string } | null;
}

export async function callStructured<T>(c: StructuredCall): Promise<{ data: T; callId: string; usdMicros: number }> {
  const key = apiKey();
  c.signal?.throwIfAborted();
  const model = modelForStage(c.stage);
  const params = {
    model,
    instructions: c.system,
    input: [{ role: "user", content: c.user }],
    reasoning: { effort: c.effort },
    text: { format: { type: "json_schema", name: `commentary_${c.stage}`, strict: true, schema: c.schema } },
    max_output_tokens: c.maxTokens,
    ...(c.webSearchDomains?.length ? { tools: [{ type: "web_search", filters: { allowed_domains: c.webSearchDomains } }], include: ["web_search_call.action.sources"] } : {}),
    stream: true,
    store: false,
    // Pin Standard processing so project-level tier settings cannot silently change the budget.
    service_tier: "default",
  };
  const requestJson = JSON.stringify(params);
  const searches = c.webSearchDomains?.length ? c.maxSearches ?? 4 : 0;
  const estimate = estimateCall(Buffer.byteLength(requestJson), c.maxTokens, model) + searches * (WEB_SEARCH_CALL_MICROS + Math.ceil(WEB_SEARCH_INPUT_TOKENS * MODEL_PRICES[model].input));
  const release = reserveModelBudget(c.db, estimate, { studyId: c.studyId, runId: c.runId });
  const callId = uuidv7();
  const started = Date.now();
  let response: ModelResponse | null = null;
  let error: ModelError | null = null;
  let data: T | undefined;
  let mayHaveCharged = false;
  try {
    try {
      c.signal?.throwIfAborted();
      mayHaveCharged = true;
      const res = await fetchOpenai("/responses", key, { body: params, signal: c.signal });
      if (!res.ok) {
        mayHaveCharged = res.status >= 500;
        throw await responseError(res, key);
      }
      response = await readResponseStream(res);
      if (response.status === "incomplete") {
        if (response.incomplete_details?.reason === "max_output_tokens") {
          throw new ModelError("truncated", "The model's answer was cut off. Your notes and sources are saved. Retry, or narrow the passage.");
        }
        throw new ModelError("refusal", "The model couldn't finish this request. Your notes and sources are saved. Try revising the request, or continue without it.");
      }
      if (response.status === "failed") throw new ModelError("api", "OpenAI couldn't finish this request. Your notes are saved. Retry in a moment.", safeDetail(response.error?.message ?? response.error?.code ?? "response.failed", key));
      if (response.status !== "completed") throw new ModelError("invalid_output", "The model's answer didn't finish. Your notes are saved. Retry.");
      const content = (response.output ?? []).flatMap((item) => item.type === "message" ? item.content ?? [] : []);
      if (content.some((item) => item.type === "refusal")) throw new ModelError("refusal", "The model declined this request. Your notes and sources are saved. Revise the request, or continue without it.");
      const text = content.filter((item) => item.type === "output_text").map((item) => item.text ?? "").join("");
      try {
        const parsed: unknown = JSON.parse(text);
        if (!matchesSchema(parsed, c.schema)) throw new Error("schema mismatch");
        data = parsed as T;
      } catch {
        throw new ModelError("invalid_output", "The model's answer wasn't in the expected shape. Your notes are saved. Retry.");
      }
    } catch (e) {
      if (e instanceof FetchError && e.status === null) mayHaveCharged = false;
      error = toModelError(e, key);
    }

    const usage = validUsage(response?.usage) ? response!.usage! : null;
    const hasUsage = usage !== null;
    // A disconnected stream can still be billed. Keep a conservative estimate in the ledger, visibly
    // identified as estimated, rather than treating unknown usage as free and permitting unbounded retries.
    const estimated = !hasUsage && mayHaveCharged;
    const searchCalls = (response?.output ?? []).filter((item) => item.type === "web_search_call").length;
    const cost = hasUsage ? costOfUsage(usage!, model) + searchCalls * WEB_SEARCH_CALL_MICROS : estimated ? estimate : 0;
    c.db.prepare(
      `INSERT INTO llm_calls (id, stage, study_id, run_id, model, served_model, effort, prompt_version, request_json, response_json, stop_reason, fallback_used,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, web_search_requests, usd_micros, latency_ms, error, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(callId, c.stage, c.studyId ?? null, c.runId ?? null, model, response?.model ?? null, c.effort, c.promptVersion,
      requestJson, response ? JSON.stringify(response).replaceAll(key, "[redacted]") : null, response?.incomplete_details?.reason ?? response?.status ?? null, 0,
      usage?.input_tokens ?? null, usage?.output_tokens ?? null, usage?.input_tokens_details?.cached_tokens ?? null, usage?.input_tokens_details?.cache_write_tokens ?? null,
      searchCalls, cost, Date.now() - started, error ? error.detail ?? error.message : estimated ? "Usage unavailable; cost is a conservative estimate." : null, nowIso());
    recordCost(c.db, { vendor: "openai", category: estimated ? "estimated_tokens" : "tokens", refTable: "llm_calls", refId: callId, studyId: c.studyId, runId: c.runId, units: (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0), usdMicros: cost });
    if (c.runId) c.db.prepare("UPDATE research_runs SET usd_micros = usd_micros + ? WHERE id = ?").run(cost, c.runId);
    log(error ? "warn" : "info", "llm", error ? "call_failed" : "call_ok", { stage: c.stage, model, ms: Date.now() - started, usd_micros: cost, estimated, kind: error?.kind, detail: error?.detail });
    if (error) throw error;
    return { data: data!, callId, usdMicros: cost };
  } finally {
    release();
  }
}

async function readResponseStream(res: Response): Promise<ModelResponse> {
  if (!res.body || !res.headers.get("content-type")?.includes("text/event-stream")) throw new ModelError("invalid_output", "OpenAI returned an unexpected response. Your notes are saved. Retry.");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  function event(frame: string): ModelResponse | null {
    const text = frame.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
    if (!text || text === "[DONE]") return null;
    let item: any;
    try { item = JSON.parse(text); }
    catch { throw new ModelError("invalid_output", "OpenAI's answer couldn't be read. Your notes are saved. Retry."); }
    if (["response.completed", "response.incomplete", "response.failed"].includes(item.type)) return item.response;
    if (item.type === "error") throw new ModelError("api", "OpenAI couldn't finish this request. Your notes are saved. Retry in a moment.");
    return null;
  }
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const response = event(frame);
        if (response) return response;
      }
      if (done) {
        const response = event(buffer);
        if (response) return response;
        throw new ModelError("connection", "The connection to OpenAI ended before the answer finished. Your notes are saved. Check your connection and retry.");
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function validUsage(usage: Usage | null | undefined): boolean {
  if (!usage) return false;
  const counts = [usage.input_tokens, usage.output_tokens, usage.input_tokens_details?.cached_tokens ?? 0, usage.input_tokens_details?.cache_write_tokens ?? 0];
  return counts.every((n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0) &&
    counts[2]! + counts[3]! <= counts[0]!;
}

/** Validate the JSON Schema subset used by the app even when a fixture/proxy returns invalid JSON. */
function matchesSchema(value: unknown, schema: Record<string, any>): boolean {
  if (schema.anyOf) return schema.anyOf.some((s: Record<string, any>) => matchesSchema(value, s));
  if (schema.enum && !schema.enum.includes(value)) return false;
  switch (schema.type) {
    case "null": return value === null;
    case "string": return typeof value === "string";
    case "integer": return typeof value === "number" && Number.isInteger(value);
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "boolean": return typeof value === "boolean";
    case "array": return Array.isArray(value) && value.every((item) => matchesSchema(item, schema.items));
    case "object": {
      if (!value || typeof value !== "object" || Array.isArray(value)) return false;
      const object = value as Record<string, unknown>;
      if ((schema.required ?? []).some((key: string) => !(key in object))) return false;
      return Object.entries(object).every(([key, item]) => schema.properties?.[key] ? matchesSchema(item, schema.properties[key]) : schema.additionalProperties !== false);
    }
    default: return false;
  }
}

function safeDetail(text: string, key: string): string {
  return text.replaceAll(key, "[redacted]").replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]").slice(0, 160);
}

async function responseError(res: Response, key: string): Promise<ModelError> {
  let detail = `HTTP ${res.status}`;
  try {
    const body = await res.json() as { error?: { message?: string } };
    if (body.error?.message) detail = safeDetail(body.error.message, key);
  } catch { /* retain status, never an HTML error page */ }
  if ([401, 403].includes(res.status)) return new ModelError("auth", "OpenAI didn't accept the key or model access. Reading and saving notes still work. Check the key and project access in Settings → OpenAI.", detail);
  if (res.status === 429) return new ModelError("rate_limit", "OpenAI is limiting requests or the API project is out of credit. Your notes are saved. Check billing, then retry in a minute.", detail);
  if (res.status >= 500) return new ModelError("overloaded", "OpenAI is having trouble right now. Your notes are saved. Retry in a moment.", detail);
  return new ModelError("api", "OpenAI couldn't accept this request. Your notes are saved. Retry; if it keeps happening, check the app's logs.", detail);
}

function toModelError(e: unknown, key: string): ModelError {
  if (e instanceof ModelError) return e;
  if (e instanceof Error && e.name === "AbortError") return new ModelError("api", "The request was cancelled. Your notes and sources are saved. You can continue studying or retry.");
  return new ModelError("connection", "Couldn't finish the request to OpenAI. Reading and saving notes still work. Check your connection and retry.", safeDetail(e instanceof Error ? `${e.name}: ${e.message}` : String(e), key));
}

/** Check access to both configured models without a billable completion. */
export async function testOpenaiKey(): Promise<{ ok: boolean; message: string }> {
  let key = "";
  try {
    key = apiKey();
    for (const model of [RESEARCH_MODEL, WRITING_MODEL]) {
      const res = await fetchOpenai(`/models/${model}`, key);
      if (!res.ok) throw await responseError(res, key);
      const body = await res.json() as { id?: string };
      if (body.id !== model) throw new ModelError("api", "OpenAI's model access check returned an unexpected answer. Your notes are saved. Retry the connection test.");
    }
    return { ok: true, message: `Connected. ${RESEARCH_MODEL} is available for research and ${WRITING_MODEL} for writing and checks.` };
  } catch (e) {
    return { ok: false, message: toModelError(e, key || "[no-key]").message };
  }
}
