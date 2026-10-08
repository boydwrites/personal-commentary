/** Offline product walkthrough. Every model and source response is a fixture. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { zipSync, strToU8 } from "fflate";
import { fakeModel, sse } from "../tests/fixtures/fake-model.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = path.join(root, "tests", "fixtures");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "personal-commentary-demo-"));
const check = process.argv.includes("--check");
const port = Number(process.env.COMMENTARY_PORT ?? 8791);
const datasets = path.join(temp, "datasets");
const web = path.join(temp, "web");

// Set all locations before importing application modules. Never read a real key or study library.
Object.assign(process.env, {
  COMMENTARY_TEST: "1", COMMENTARY_DEMO: "1", COMMENTARY_SECRETS_FROM_ENV: "1",
  COMMENTARY_DATA_DIR: temp, COMMENTARY_LOG_DIR: temp, COMMENTARY_NOTES_DIR: path.join(temp, "notes"),
  COMMENTARY_DATASET_DIR: datasets, COMMENTARY_WEB_DIR: web,
  COMMENTARY_OPENAI_API_KEY: "demo-fixture", COMMENTARY_OPENAI_BASE_URL: "http://127.0.0.1:8899/v1",
});

fs.mkdirSync(path.join(datasets, "bible"), { recursive: true });
fs.mkdirSync(path.join(datasets, "openbible"), { recursive: true });
fs.copyFileSync(path.join(fixtures, "demo-bible.json"), path.join(datasets, "bible", "BSB.json"));
// Self-authored links and ranking values in the parser's expected tab-separated format.
fs.writeFileSync(path.join(datasets, "openbible", "cross-references.zip"), zipSync({
  "cross-references.txt": strToU8("From Verse\tTo Verse\tVotes\nExod.33.3\tActs.7.51\t10\nExod.33.3\tExod.32.9\t9\n"),
}));

if (!fs.existsSync(path.join(root, "dist", "web", "index.html"))) {
  fs.rmSync(temp, { recursive: true, force: true });
  throw new Error("Build the web app first with npm run build, or use npm run demo.");
}
fs.cpSync(path.join(root, "dist", "web"), web, { recursive: true });
const index = path.join(web, "index.html");
const banner = '<div role="status" style="padding:10px 16px;background:#fff0be;color:#352708;font:13px system-ui;text-align:center">Offline demo · scripted AI and synthetic commentary · Exodus 33:3 · source links and X open online</div>';
fs.writeFileSync(index, fs.readFileSync(index, "utf8").replace("<body>", `<body>${banner}`));

// Deliberately no fallback to the real fetch: unknown URLs fail locally.
const realFetch = globalThis.fetch;
let fixtureModelCalls = 0;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const html = (file: string) => new Response(fs.readFileSync(path.join(fixtures, file), "utf8"), { headers: { "content-type": "text/html" } });
  if (url.startsWith("http://127.0.0.1:8899/v1")) {
    if (url.includes("/models/")) return Response.json({ id: url.split("/").at(-1) });
    try {
      const request = JSON.parse(String(init?.body));
      fixtureModelCalls++;
      return sse({ json: fakeModel(request), model: request.model });
    } catch {
      return Response.json({ error: { message: "This scripted demo only supports the Exodus 33:3 walkthrough." } }, { status: 400 });
    }
  }
  if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
  if (url.startsWith("https://biblehub.com/commentaries/exodus/33-3.htm")) return html("biblehub-exodus-33-3.htm");
  const chapter = url.match(/^https:\/\/biblehub\.com\/commentaries\/(wes|mhc|clarke)\/exodus\/33\.htm$/);
  if (chapter) return html(`biblehub-${chapter[1]}-exodus-33.htm`);
  if (url === "https://enduringword.com/bible-commentary/exodus-33/") return html("enduringword-exodus-33.htm");
  if (url === "https://www.bible.com/verse-of-the-day") return new Response("<title>Verse of the Day - Exodus 33:3 - Bible App</title>", { headers: { "content-type": "text/html" } });
  if (url.includes("ourmanna")) return Response.json({ verse: { details: { reference: "Exodus 33:3" } } });
  return new Response("No source fixture is included for this URL in the offline demo.", { status: 404, headers: { "content-type": "text/plain" } });
}) as typeof fetch;

const { buildApp, CAPABILITY } = await import("../server/index.ts");
const { setPrefs } = await import("../server/prefs.ts");
const { app, db } = await buildApp(port);
setPrefs(db, { onboarded: true });
const headers = { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, "x-app-capability": CAPABILITY };
async function call(method: "GET" | "POST" | "PATCH", url: string, payload?: Record<string, unknown>) {
  const response = await app.inject({ method, url, headers, payload });
  assert.equal(response.statusCode, 200, `${method} ${url}: ${response.body}`);
  return JSON.parse(response.body);
}
let closed = false;
async function cleanup() {
  if (closed) return;
  closed = true;
  await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 1000))]);
  db.close();
  globalThis.fetch = realFetch;
  fs.rmSync(temp, { recursive: true, force: true });
}

try {
  const study = await call("POST", "/api/studies", { ref: "Exodus 33:3", origin: "manual" });
  await call("PATCH", `/api/studies/${study.id}`, {
    title: "Presence and the promise",
    note: "Example notes for the walkthrough: The land remains promised, but presence is withheld. Read Moses’ response in Exodus 33:15 before drawing a conclusion. Check the source behind each quotation.",
  });
  if (check) {
    const run = await call("POST", `/api/studies/${study.id}/research`, { depth: "standard" });
    let status = "queued";
    for (let n = 0; n < 300; n++) {
      status = (db.prepare("SELECT status FROM research_runs WHERE id = ?").get(run.runId) as { status: string }).status;
      if (!["queued", "running"].includes(status)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(status, "succeeded", "Fixture research must complete");
    const detail = await call("GET", `/api/studies/${study.id}`);
    assert.ok(detail.cards.length >= 4, "The brief must contain verified cards");
    const connection = detail.cards.find((card: { type: string }) => card.type === "connection");
    assert.equal(connection?.status_quote, "dequoted", "The fabricated quotation must become a paraphrase");
    assert.ok(!connection.body.includes("“You stiff-necked"), "The unsupported quotation marks must be removed");
    const draft = await call("POST", `/api/studies/${study.id}/drafts`, { kind: "edit", format: "notes" });
    assert.ok(draft.parts.some((part: string) => part.includes("Exodus 33:3")), "The fixture draft must be returned");
    assert.ok(fixtureModelCalls >= 3, "The actual model transport must have used fixture responses");
    assert.ok((await app.inject({ method: "GET", url: "/", headers })).body.includes("Offline demo"));
    console.log(`Offline demo passed: research, ${detail.cards.length} cards, drafting, UI label, and isolated temporary storage. All fetches used local fixtures.`);
    await cleanup();
  } else {
    await app.listen({ host: "127.0.0.1", port });
    console.log(`Offline demo: http://127.0.0.1:${port}/study/${study.id}/read`);
    console.log("Choose Start research, inspect a source, then Write → Study notes → Create a first draft.");
    console.log("Scripted responses and synthetic commentary demonstrate behavior, not AI quality. Research and drafting use no API key, external requests, or personal library. Source links and X open online. Ctrl-C removes demo data.");
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => void cleanup().finally(() => process.exit(0)));
  }
} catch (error) {
  await cleanup();
  throw error;
}
