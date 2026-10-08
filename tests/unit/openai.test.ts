import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, nowIso, type DB } from "../../server/db.ts";
import { callStructured, modelForStage, testOpenaiKey, type StructuredCall } from "../../server/llm.ts";
import { costOfUsage, estimateCall, monthTotals, recordCost } from "../../server/costs.ts";
import { getPrefs, setPrefs } from "../../server/prefs.ts";
import { fetchOpenai } from "../../server/fetcher.ts";
import { sse } from "../fixtures/fake-model.ts";

const schema = { type: "object", additionalProperties: false, required: ["note"], properties: { note: { type: "string" } } };
let db: DB;
let requests: { url: string; body: any; init: RequestInit }[];
const key = "sk-test-do-not-store";

beforeEach(() => {
  db = openDb(":memory:");
  process.env.COMMENTARY_OPENAI_API_KEY = key;
  delete process.env.COMMENTARY_OPENAI_BASE_URL;
  requests = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    const body = init.body ? JSON.parse(String(init.body)) : null;
    requests.push({ url, body, init });
    return sse({ json: { note: "A saved thought." }, model: body?.model });
  }));
});
afterEach(() => {
  db.close();
  delete process.env.COMMENTARY_OPENAI_API_KEY;
  delete process.env.COMMENTARY_OPENAI_BASE_URL;
  vi.unstubAllGlobals();
});

function call(overrides: Partial<StructuredCall> = {}) {
  return callStructured<{ note: string }>({ db, stage: "brief_scripture", promptVersion: "test-v1", system: "Keep the writer's meaning.", user: "A thought.", schema, effort: "medium", maxTokens: 800, ...overrides });
}

it("routes research and support stages to Luna and writing/review to Sol", async () => {
  for (const stage of ["brief_scripture", "brief_background", "brief_voices", "angle", "allusions", "translate", "discover", "draft", "sharpen", "review"] as const) {
    const result = await call({ stage });
    const expected = ["draft", "sharpen", "review"].includes(stage) ? "gpt-6.1-sol" : "gpt-6-luna";
    expect(modelForStage(stage)).toBe(expected);
    expect(result.data).toEqual({ note: "A saved thought." });
    expect(requests.at(-1)?.body).toMatchObject({ model: expected, reasoning: { effort: "medium" }, stream: true, store: false, service_tier: "default", max_output_tokens: 800, text: { format: { type: "json_schema", strict: true, schema } } });
    expect(requests.at(-1)?.url).toBe("https://api.openai.com/v1/responses");
    expect(requests.at(-1)?.init.redirect).toBe("error");
  }
  const calls = db.prepare("SELECT model, served_model, request_json FROM llm_calls").all() as any[];
  expect(calls).toHaveLength(10);
  expect(calls.every((row) => row.model === row.served_model)).toBe(true);
  expect(JSON.stringify(calls)).not.toContain(key);
  expect((db.prepare("SELECT COUNT(*) n FROM cost_ledger WHERE vendor = 'openai'").get() as any).n).toBe(10);
});

it("counts cache reads/writes within input, reasoning within output, and each model's price", () => {
  const usage = { input_tokens: 1000, input_tokens_details: { cached_tokens: 200, cache_write_tokens: 300 }, output_tokens: 500, output_tokens_details: { reasoning_tokens: 100 } };
  expect(costOfUsage(usage, "gpt-6-luna")).toBe(340);
  expect(costOfUsage(usage, "gpt-6.1-sol")).toBe(6770);
  expect(costOfUsage({ input_tokens: 272_001, output_tokens: 10 }, "gpt-6.1-sol")).toBe(1_088_154);
  expect(estimateCall(1000, 800, "gpt-6.1-sol")).toBeGreaterThan(estimateCall(1000, 800, "gpt-6-luna"));
});

it("reads chunked UTF-8 and CRLF SSE frames", async () => {
  const body = (await sse({ json: { note: "Café — שלום" } }).text()).replaceAll("\n", "\r\n");
  const encoded = new TextEncoder().encode(body);
  vi.mocked(fetch).mockImplementation(async () => new Response(new ReadableStream({
    start(controller) {
      for (let n = 0; n < encoded.length; n += 7) controller.enqueue(encoded.slice(n, n + 7));
      controller.close();
    },
  }), { headers: { "content-type": "text/event-stream" } }));
  expect((await call()).data.note).toBe("Café — שלום");
});

it.each([
  ["refusal", { refusal: true }],
  ["truncated", { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }],
  ["api", { status: "failed", error: { code: "server_error", message: "Fixture failure" } }],
  ["invalid_output", { text: "not JSON" }],
  ["invalid_output", { json: { other: "wrong shape" } }],
] as const)("records billed %s failures without accepting their output", async (kind, response) => {
  vi.mocked(fetch).mockResolvedValueOnce(sse(response));
  await expect(call()).rejects.toMatchObject({ kind });
  const row = db.prepare("SELECT error, usd_micros FROM llm_calls").get() as any;
  expect(row.error).toBeTruthy();
  expect(row.usd_micros).toBe(340);
  expect(monthTotals(db).openaiMicros).toBe(340);
});

it.each([[401, "auth"], [403, "auth"], [429, "rate_limit"], [400, "api"]])("maps HTTP %s without retries or a phantom charge", async (status, kind) => {
  vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: `Bad key ${key}` } }), { status: status as number, headers: { "content-type": "application/json" } }));
  await expect(call()).rejects.toMatchObject({ kind });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(monthTotals(db).totalMicros).toBe(0);
  const row = db.prepare("SELECT * FROM llm_calls").get() as any;
  expect(row.error).not.toContain(key);
});

it("retains a visible conservative charge when a billed stream disconnects without usage", async () => {
  vi.mocked(fetch).mockResolvedValueOnce(new Response('data: {"type":"response.created"}\n\n', { headers: { "content-type": "text/event-stream" } }));
  await expect(call()).rejects.toMatchObject({ kind: "connection" });
  const cost = db.prepare("SELECT category, usd_micros FROM cost_ledger").get() as any;
  expect(cost.category).toBe("estimated_tokens");
  expect(cost.usd_micros).toBeGreaterThan(0);
  expect(monthTotals(db).estimatedMicros).toBe(cost.usd_micros);
  setPrefs(db, { budgets: { ...getPrefs(db).budgets, monthlyOpenaiUsd: cost.usd_micros / 1_000_000 } });
  await expect(call()).rejects.toMatchObject({ cap: "monthly" });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("counts concurrent in-flight calls toward the monthly cap", async () => {
  let complete!: (r: Response) => void;
  vi.mocked(fetch).mockImplementationOnce(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    const est = estimateCall(Buffer.byteLength(JSON.stringify(body)), body.max_output_tokens, body.model);
    setPrefs(db, { budgets: { ...getPrefs(db).budgets, monthlyOpenaiUsd: est * 1.5 / 1_000_000 } });
    return new Promise((resolve) => { complete = resolve; });
  });
  const first = call();
  await expect(call()).rejects.toMatchObject({ cap: "monthly" });
  complete(sse({ json: { note: "Done" } }));
  await first;
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("does not call or charge when no key is configured or cancellation predates the request", async () => {
  delete process.env.COMMENTARY_OPENAI_API_KEY;
  await expect(call()).rejects.toMatchObject({ kind: "no_key" });
  process.env.COMMENTARY_OPENAI_API_KEY = key;
  await expect(call({ signal: AbortSignal.abort() })).rejects.toMatchObject({ name: "AbortError" });
  expect(fetch).not.toHaveBeenCalled();
  expect((db.prepare("SELECT COUNT(*) n FROM llm_calls").get() as any).n).toBe(0);
});

it("checks access to both selected models without a completion", async () => {
  vi.mocked(fetch).mockImplementation(async (url) => new Response(JSON.stringify({ id: String(url).split("/").at(-1) }), { headers: { "content-type": "application/json" } }));
  expect((await testOpenaiKey()).ok).toBe(true);
  expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toEqual(["https://api.openai.com/v1/models/gpt-6-luna", "https://api.openai.com/v1/models/gpt-6.1-sol"]);
  expect(monthTotals(db).totalMicros).toBe(0);
});

it("restricts fixture endpoints to loopback and explicit test/demo mode", async () => {
  process.env.COMMENTARY_OPENAI_BASE_URL = "https://untrusted.example/v1";
  await expect(fetchOpenai("/responses", key)).rejects.toThrow(/local/);
  expect(fetch).not.toHaveBeenCalled();
  process.env.COMMENTARY_OPENAI_BASE_URL = "http://127.0.0.1:8899/v1";
  await fetchOpenai("/responses", key, { body: {} });
  expect(requests[0].url).toBe("http://127.0.0.1:8899/v1/responses");
});

it("preserves the legacy budget and counts historical spend toward the model cap", async () => {
  db.prepare("INSERT INTO preferences (key,value_json,updated_at) VALUES ('budgets',?,?)").run(JSON.stringify({ perRunUsd: 1, perStudyUsd: 2, monthlyAnthropicUsd: 23, monthlyXUsd: 7 }), nowIso());
  expect(getPrefs(db).budgets).toEqual({ perRunUsd: 1, perStudyUsd: 2, monthlyOpenaiUsd: 23, monthlyXUsd: 7 });
  recordCost(db, { vendor: "anthropic", category: "tokens", units: 100, usdMicros: 23_000_000 });
  expect(monthTotals(db)).toMatchObject({ openaiMicros: 0, anthropicMicros: 23_000_000, modelMicros: 23_000_000 });
  await expect(call()).rejects.toMatchObject({ cap: "monthly" });
});

it("migration 003 retains each old charge and permits OpenAI charges", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "commentary-migration-"));
  const file = path.join(dir, "legacy.db");
  const old = new Database(file);
  old.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    INSERT INTO schema_migrations VALUES (1,'2026-10-01'),(2,'2026-10-01');
    CREATE TABLE authors (id TEXT PRIMARY KEY);
    CREATE TABLE cards (id TEXT PRIMARY KEY, study_id TEXT, status_interpretation TEXT);
    CREATE TABLE research_runs (id TEXT PRIMARY KEY, status TEXT);
    CREATE TABLE sources (id TEXT PRIMARY KEY, rights TEXT, text TEXT, content_hash TEXT, edition TEXT, author_name TEXT, work TEXT, url TEXT);
    CREATE TABLE drafts (id TEXT PRIMARY KEY);
    CREATE TABLE note_revisions (id TEXT PRIMARY KEY, study_id TEXT, note TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE studies (id TEXT PRIMARY KEY, format TEXT NOT NULL DEFAULT 'single', first_observation TEXT, note TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE working_texts (study_id TEXT PRIMARY KEY, format TEXT, parts_json TEXT, source_reply TEXT, origin_draft_id TEXT, text_hash TEXT, updated_at TEXT);
    CREATE TABLE text_revisions (id TEXT PRIMARY KEY, study_id TEXT, parts_json TEXT, source_reply TEXT, text_hash TEXT, cause TEXT, created_at TEXT);
    CREATE TABLE cost_ledger (
      id TEXT PRIMARY KEY, occurred_at TEXT NOT NULL, vendor TEXT NOT NULL CHECK (vendor IN ('anthropic','x')),
      category TEXT NOT NULL, ref_table TEXT, ref_id TEXT, study_id TEXT, run_id TEXT, units INTEGER NOT NULL, usd_micros INTEGER NOT NULL
    );
    INSERT INTO cost_ledger VALUES ('old','2026-10-01','anthropic','tokens','llm_calls','call','study','run',42,314);
  `);
  old.close();
  const migrated = openDb(file);
  try {
    expect(migrated.prepare("SELECT * FROM cost_ledger WHERE id = 'old'").get()).toEqual({ id: "old", occurred_at: "2026-10-01", vendor: "anthropic", category: "tokens", ref_table: "llm_calls", ref_id: "call", study_id: "study", run_id: "run", units: 42, usd_micros: 314 });
    migrated.prepare("INSERT INTO cost_ledger (id,occurred_at,vendor,category,units,usd_micros) VALUES ('new',?,'openai','tokens',12,100)").run(nowIso());
    expect((migrated.prepare("SELECT COUNT(*) n FROM cost_ledger").get() as any).n).toBe(2);
  } finally { migrated.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
