import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildApp, CAPABILITY } from "../../server/index.ts";
import { PRIVATE_SENTINEL, seedResearchCorpus } from "../fixtures/research-corpus.ts";

let built: Awaited<ReturnType<typeof buildApp>>;
const headers = { host: "127.0.0.1:8790", origin: "http://127.0.0.1:8790" };
beforeEach(async () => {
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Corpus review must be local"); }));
  built = await buildApp(8790, ":memory:");
  seedResearchCorpus(built.db);
});
afterEach(async () => { await built.app.close(); built.db.close(); vi.unstubAllGlobals(); });
const get = (suffix: string) => built.app.inject({ method: "GET", url: `/api/studies/private-study/${suffix}`, headers });
const post = (suffix: string, payload: Record<string, unknown>, authorized = true) => built.app.inject({
  method: "POST", url: `/api/studies/private-study/corpus/${suffix}`,
  headers: { ...headers, ...(authorized ? { "x-app-capability": CAPABILITY } : {}) }, payload,
});

it("requires local authorization and exact reviewed content before serving the separate research attachment", async () => {
  const inspection = await get("corpus");
  expect(inspection.statusCode).toBe(200);
  expect(inspection.headers["cache-control"]).toBe("no-store");
  const candidate = inspection.json();
  expect(candidate.status).toBe("needs_review");
  expect(inspection.body).not.toContain(PRIVATE_SENTINEL);
  expect((await get("corpus.json")).statusCode).toBe(409);
  const approval = {
    expectedHash: candidate.hash, reviewedPrivacy: true, reviewedQuality: true, reviewedRights: true,
    sourceRights: candidate.dependencies.map((s: { sourceId: string }) => ({ sourceId: s.sourceId, licenseUrl: "https://example.org/license", provenanceUrl: "https://example.org/source", attribution: "Fixture source attribution" })),
  };
  expect((await post("review", approval, false)).statusCode).toBe(403);
  expect((await post("review", { ...approval, reviewedPrivacy: false })).statusCode).toBe(400);
  expect((await post("review", { ...approval, expectedHash: "0".repeat(64) })).statusCode).toBe(409);
  const approved = await post("review", approval);
  expect(approved.statusCode, approved.body).toBe(200);
  expect(approved.json().status).toBe("approved");
  const file = await get("corpus.json");
  expect(file.statusCode, file.body).toBe(200);
  expect(file.headers["content-disposition"]).toBe('attachment; filename="Exodus 33-3-research.json"');
  expect(file.headers["cache-control"]).toBe("no-store");
  expect(file.json().format).toBe("personal-commentary.research-corpus");
  expect(file.body).not.toContain(PRIVATE_SENTINEL);
  expect(file.json().manifest.totalCostMicros).toBe(123);
  const privateFile = await get("export.json");
  expect(privateFile.body).toContain(PRIVATE_SENTINEL);
  expect(privateFile.json().data.research_corpus_packages).toHaveLength(1);
  expect((await post("revoke", { expectedHash: candidate.hash })).statusCode).toBe(200);
  expect((await get("corpus.json")).statusCode).toBe(409);
  expect((await get("export.json")).statusCode).toBe(200);
  expect(globalThis.fetch).not.toHaveBeenCalled();
});
