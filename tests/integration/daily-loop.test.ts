// Daily-loop acceptance against a synthetic Exodus 33:3 scenario.
// Model calls replay through the Responses API transport from a fake streaming endpoint; Bible Hub and the
// preachers' sites replay self-authored structural fixtures. Jewish commentary (Sefaria) is no longer fetched, so a call to it fails the test. Local datasets (BSB, Church Fathers, OpenBible) must be downloaded first.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "personal-commentary-test-"));
process.env.COMMENTARY_TEST = "1";
process.env.COMMENTARY_DATA_DIR = tmp;
process.env.COMMENTARY_LOG_DIR = tmp;
process.env.COMMENTARY_DATASET_DIR ??= path.join(os.homedir(), "Library", "Application Support", "PersonalCommentary", "datasets");
process.env.COMMENTARY_OPENAI_API_KEY = "test-key";
process.env.COMMENTARY_OPENAI_BASE_URL = "http://127.0.0.1:8899/v1";

const FIX = path.join(__dirname, "..", "fixtures");
import { sse, fakeModel } from "../fixtures/fake-model.ts";
const hasDatasets = fs.existsSync(path.join(process.env.COMMENTARY_DATASET_DIR!, "bible", "BSB.json"));

// ---- fake services ----
const modelRequests: any[] = [];
let researchGate: Promise<void> | null = null;

const realFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input.url ?? String(input);
    if (url.startsWith("http://127.0.0.1:8899/v1")) {
      if (url.includes("/models/")) return new Response(JSON.stringify({ id: url.split("/").at(-1) }), { headers: { "content-type": "application/json" } });
      const body = JSON.parse(init.body);
      modelRequests.push({ url, body, headers: init.headers });
      if (researchGate) await researchGate;
      return sse({ json: fakeModel(body), model: body.model });
    }
    if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
    if (url.startsWith("https://biblehub.com/commentaries/exodus/33-3.htm")) return new Response(fs.readFileSync(path.join(FIX, "biblehub-exodus-33-3.htm")), { headers: { "content-type": "text/html" } });
    const chapter = url.match(/^https:\/\/biblehub\.com\/commentaries\/(wes|mhc|clarke)\/exodus\/33\.htm$/);
    if (chapter) return new Response(fs.readFileSync(path.join(FIX, `biblehub-${chapter[1]}-exodus-33.htm`)), { headers: { "content-type": "text/html" } });
    if (url === "https://enduringword.com/bible-commentary/exodus-33/") return new Response(fs.readFileSync(path.join(FIX, "enduringword-exodus-33.htm")), { headers: { "content-type": "text/html" } });
    if (url.includes("ourmanna")) return new Response(JSON.stringify({ verse: { details: { reference: "James 1:22" } } }), { headers: { "content-type": "application/json" } });
    throw new Error(`Unexpected network call in tests: ${url}`);
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe.skipIf(!hasDatasets)("daily loop on Exodus 33:3", async () => {
  const { buildApp, CAPABILITY } = await import("../../server/index.ts");
  const PORT = 8790;
  const { app, db } = await buildApp(PORT, path.join(tmp, "personal-commentary.db"));
  const H = { host: `127.0.0.1:${PORT}`, origin: `http://127.0.0.1:${PORT}`, "x-app-capability": CAPABILITY };
  const call = async (method: string, url: string, payload?: any) => {
    const r = await app.inject({ method: method as any, url, headers: H, payload });
    return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
  };
  let studyId = "";

  async function waitForRun(runId: string) {
    for (let i = 0; i < 200; i++) {
      const r = db.prepare("SELECT status FROM research_runs WHERE id = ?").get(runId) as any;
      if (!["queued", "running"].includes(r.status)) return r.status;
      await new Promise((res) => setTimeout(res, 50));
    }
    throw new Error("run did not finish");
  }

  it("refuses foreign hosts and missing capabilities", async () => {
    expect((await app.inject({ method: "GET", url: "/api/health", headers: { host: "evil.test" } })).statusCode).toBe(421);
    expect((await app.inject({ method: "POST", url: "/api/studies", headers: { host: H.host, origin: H.origin }, payload: {} })).statusCode).toBe(403);
  });

  it("stores the OpenAI key without exposing it and checks both configured models", async () => {
    const saved = await call("PUT", "/api/keys/openai_api_key", { value: "test-replacement-key" });
    expect(saved.body).toEqual({ ok: true, present: true });
    const status = (await call("GET", "/api/status")).body;
    expect(status.keys).toEqual({ openai: true });
    expect(status.models).toEqual({ research: "gpt-6-luna", writing: "gpt-6.1-sol" });
    expect(JSON.stringify(status)).not.toContain("test-replacement-key");
    expect((await call("POST", "/api/keys/openai_api_key/test")).body.ok).toBe(true);
    expect(modelRequests).toHaveLength(0);
    await call("PUT", "/api/keys/openai_api_key", { value: "test-key" });
  });

  it("validates spending limits and preserves limits omitted from a settings change", async () => {
    expect((await call("PUT", "/api/preferences", { budgets: { monthlyOpenaiUsd: -1 } })).status).toBe(400);
    expect((await call("PUT", "/api/preferences", { budgets: { monthlyOpenaiUsd: "none" } })).status).toBe(400);
    const updated = await call("PUT", "/api/preferences", { budgets: { monthlyOpenaiUsd: 40 } });
    expect(updated.body.budgets).toEqual({ perRunUsd: 2, perStudyUsd: 3, monthlyOpenaiUsd: 40, monthlyXUsd: 10 });
  });

  it("creates a study and runs research into an organized, verified brief", async () => {
    const created = await call("POST", "/api/studies", { ref: "Exodus 33:3", origin: "manual" });
    expect(created.status).toBe(200);
    studyId = created.body.id;
    const privateFields = ["PRIVATE_INITIAL_8172", "PRIVATE_REFLECTION_8172", "PRIVATE_QUESTION_8172", "PRIVATE_FRAME_8172", "PRIVATE_CARE_8172", "PRIVATE_PRIOR_NOTE_8172", "PRIVATE_LEGACY_CARD_8172"];
    db.prepare("UPDATE studies SET first_observation = ?, note = ?, question = ? WHERE id = ?").run(...privateFields.slice(0, 3), studyId);
    await call("PUT", "/api/preferences", { theologicalFrame: privateFields[3], careTopics: [privateFields[4]] });
    const priorId = (await call("POST", "/api/studies", { ref: "Exodus 33:3", origin: "manual" })).body.id;
    db.prepare("UPDATE studies SET note = ? WHERE id = ?").run(privateFields[5], priorId);
    const legacyAt = new Date().toISOString();
    db.prepare("INSERT INTO research_runs (id, study_id, depth, trigger, status, prompt_version, queued_at) VALUES ('private-legacy-run', ?, 'standard', 'manual', 'succeeded', 'legacy', ?)").run(priorId, legacyAt);
    db.prepare("INSERT INTO cards (id, run_id, study_id, type, title, body, body_model, relationship, priority, visible_by_default, status_source, status_quote, selected, created_at) VALUES ('private-legacy-card', 'private-legacy-run', ?, 'commentary', ?, ?, ?, 'editor_synthesis', 1, 1, 'unavailable', 'none', 1, ?)").run(priorId, privateFields[6], privateFields[6], privateFields[6], legacyAt);
    let releaseResearch!: () => void;
    researchGate = new Promise<void>((resolve) => { releaseResearch = resolve; });
    const r = await call("POST", `/api/studies/${studyId}/research`, { depth: "standard" });
    expect(r.body.reused).toBeUndefined(); // A matching passage is insufficient: legacy output can contain personal notes.
    const simultaneous = (await call("POST", "/api/studies", { ref: "Exodus 33:3", origin: "manual" })).body.id;
    const queued = await call("POST", `/api/studies/${simultaneous}/research`, { depth: "standard" });
    researchGate = null;
    releaseResearch();
    expect(await waitForRun(r.body.runId)).toBe("succeeded");
    expect(await waitForRun(queued.body.runId)).toBe("succeeded");
    expect(db.prepare("SELECT COUNT(*) n FROM llm_calls WHERE study_id = ?").get(simultaneous)).toEqual({ n: 0 });
    expect((db.prepare("SELECT COUNT(*) n FROM cards WHERE study_id = ?").get(simultaneous) as any).n).toBeGreaterThan(0);
    for (const sentinel of privateFields) expect(JSON.stringify(modelRequests)).not.toContain(sentinel);
    const neutralRun = db.prepare("SELECT research_scope, compatibility_key, research_profile_json, input_fingerprint FROM research_runs WHERE id = ?").get(r.body.runId) as any;
    expect(neutralRun.research_scope).toBe("neutral");
    expect(neutralRun.compatibility_key).toMatch(/^[a-f0-9]{64}$/);
    expect(neutralRun.input_fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.parse(neutralRun.research_profile_json).editorial).toBe("scripture-first-creedal@1");
    db.prepare("UPDATE studies SET first_observation = NULL, note = NULL, question = NULL WHERE id = ?").run(studyId);
    await call("PUT", "/api/preferences", { theologicalFrame: "", careTopics: ["Israel and the Jewish people", "Suffering and illness", "Sexuality", "Politics"] });

    const d = (await call("GET", `/api/studies/${studyId}`)).body;
    expect(d.runs[0].gaps.length).toBeGreaterThan(0);
    // Three brief calls ran together, and every item landed in its section.
    const stages = d.runs[0].stages;
    for (const k of ["SA", "SB", "SC", "V"]) expect(stages[k].status).toBe("done");
    const sections = new Set(d.cards.map((c: any) => c.section));
    for (const k of ["scripture", "christ", "culture", "commentary"]) expect(sections.has(k)).toBe(true);
    // With the Hebrew and Greek words downloaded, the word study carries the lexicon's data, not the model's.
    if (fs.existsSync(path.join(process.env.COMMENTARY_DATASET_DIR!, "stepbible", "stepbible.sqlite"))) {
      const word = d.cards.find((c: any) => c.section === "language");
      expect(word.data).toMatchObject({ strong: "H7186", lemma: "קָשֶׁה", language: "he" });
      expect(word.data.definition).toMatch(/stiff-necked/);
      expect(d.runs[0].stages.L.detail).toMatch(/Hebrew words/);
      // Its lexicon source opens as a word study: the word, and the verse it was met in.
      const ev = (await call("GET", `/api/cards/${word.id}/evidence`)).body.evidence;
      expect(ev.find((e: any) => e.source.kind === "lexicon_entry").source.word).toEqual({ strong: "H7186", at: "EXO.33.3" });
      const study = (await call("GET", `/api/words/H7186?at=EXO.33.3`)).body;
      expect(study).toMatchObject({ strong: "H7186", testament: "Old Testament", here: { ref: "Exodus 33:3" } });
      expect(study.key.every((k: any) => k.usfm !== "EXO.33.3")).toBe(true);
      const words = (await call("GET", `/api/studies/${studyId}/words`)).body;
      expect(words.words.some((w: any) => w.strong === "H7186" && w.usfm === "EXO.33.3")).toBe(true);
    }
    // A voice item always has a voice; a word study must be a word of this passage.
    expect(d.cards.some((c: any) => c.section === "commentary" && !c.author_name)).toBe(false);
    expect(d.cards.some((c: any) => c.section === "language" && c.data.strong === "G9999")).toBe(false);
    // "The New Testament says so" needs a New Testament passage; otherwise it's a thematic thread.
    const christ = d.cards.find((c: any) => c.section === "christ");
    expect(christ.group_label).toBe("thematic");
    expect(christ.flags.join(" ")).toMatch(/Moved from/);
    // Background no source states is labeled, not dressed up as sourced.
    const culture = d.cards.find((c: any) => c.section === "culture");
    expect(culture.status_source).toBe("not_applicable");
    expect(culture.limitation).toMatch(/General background/);
    // Where this sits: prose quotations that match nothing become paraphrase.
    expect(d.runs[0].brief.where.book).toMatch(/^Exodus tells/);
    expect(d.runs[0].brief.where.this_verse).not.toContain("“abandonment");
    expect(d.runs[0].brief.christ_summary).toMatch(/No New Testament writer/);
    // Connected passages carry their own words for reading in place.
    const stiff = d.cards.find((c: any) => c.section === "scripture" && c.group_label === "same_word_or_image");
    expect(stiff.scripture[0].label).toMatch(/^Acts 7:51/);
    // Connections a concordance can't vote on join the evidence, with their reason; invented or self references don't.
    const scripturePrompt = modelRequests.find((m) => m.body.input[0].content.includes("Write the Scripture part"))!.body.input[0].content as string;
    expect(scripturePrompt).toMatch(/work="John 1:14 \(BSB\)" locator="suggested connection \(points to christ\): God's presence returns/);
    expect(scripturePrompt).not.toContain("NOT.A.REF");
    expect(stages.G3.detail).toMatch(/1 from reading the whole Bible/);
    const voice = d.cards.find((c: any) => c.section === "commentary" && c.relationship === "direct_commentary");
    expect(voice.status_quote).toBe("matched");
    // Cited twice by the model (quotation and support), stored once.
    expect((db.prepare("SELECT COUNT(*) n FROM card_evidence WHERE card_id = ?").get(voice.id) as any).n).toBe(1);
    // Jewish commentary is retired: no stage, no source, no item.
    expect(stages.G2).toBeUndefined();
    expect(d.stages.map((x: any) => x.key)).not.toContain("G2");
    const connection = d.cards.find((c: any) => c.type === "connection");
    expect(connection.status_quote).toBe("dequoted");
    expect(connection.body).not.toContain("“You stiff-necked");
    expect(connection.flags.join(" ")).toMatch(/paraphrase/);
    expect(d.cards.some((c: any) => c.sources.some((s: any) => s.kind === "cross_reference"))).toBe(true);
    // Preachers and pastors: Matthew Henry, Guzik, and Clarke speak to 33:3; Wesley is silent on it; web search found nothing.
    const g5 = JSON.parse((db.prepare("SELECT stages_json FROM research_runs WHERE id = ?").get(r.body.runId) as any).stages_json).G5;
    expect(g5.status).toBe("done");
    expect(g5.detail).toBe("Matthew Henry, David Guzik, Adam Clarke");
    const search = modelRequests.find((m) => m.body.input[0].content.includes("comment in writing on"))!;
    expect(search.body.tools[0].filters.allowed_domains).toEqual(expect.arrayContaining(["spurgeon.org"]));
    // Scripture outranks every voice in what the model reads.
    const scripturePart = modelRequests.find((m) => m.body.input[0].content.includes("Write the Scripture part"))!.body.input[0].content as string;
    expect(scripturePart.indexOf('kind="cross_reference"')).toBeLessThan(scripturePart.indexOf('author="Matthew Henry"'));
    const voicesPart = modelRequests.find((m) => m.body.input[0].content.includes("Write the commentary part"))!.body.input[0].content as string;
    expect(voicesPart.indexOf('author="Matthew Henry"')).toBeLessThan(voicesPart.indexOf(`author="${voice.author_name}"`));
    expect(voicesPart).not.toMatch(/Rashi|kind="sefaria_text"|Jewish commentators/);
    expect(voicesPart).not.toContain('kind="cross_reference"');
    // Preferred voices the first pass skipped were asked about again, and came back as honest gaps.
    const followUp = modelRequests.find((m) => m.body.input[0].content.includes("for these voices only"))!.body.input[0].content as string;
    expect(followUp).toMatch(/for these voices only: Matthew Henry, David Guzik, Adam Clarke[,.]/);
    expect(d.runs[0].gaps.map((g: any) => g.author_name)).toEqual(expect.arrayContaining(["Matthew Henry", "David Guzik", "Adam Clarke"]));

    // The request followed the spec's call conventions.
    const req = modelRequests.find((m) => m.body.input[0].content.includes("Write the Scripture part"))!;
    expect(req.body.model).toBe("gpt-6-luna");
    expect(req.body.reasoning.effort).toBe("medium");
    expect(req.body.text.format.type).toBe("json_schema");
    expect(req.body.text.format.strict).toBe(true);
    expect(req.body.store).toBe(false);
    expect(req.body.service_tier).toBe("default");
    expect(req.body.stream).toBe(true);
  });

  it("never pays for the same research twice; Go deeper runs once and adds only what's new", async () => {
    const calls = () => modelRequests.length;
    const before = calls();
    const again = await call("POST", `/api/studies/${studyId}/research`, { depth: "standard" });
    expect(again.status).toBe(409);
    expect(again.body.error).toMatch(/already researched/);
    expect((await call("POST", `/api/studies/${studyId}/research`, { depth: "fill" })).status).toBe(409);
    expect(calls()).toBe(before);
    const deeper = await call("POST", `/api/studies/${studyId}/research`, { depth: "deeper" });
    expect(await waitForRun(deeper.body.runId)).toBe("succeeded");
    expect((db.prepare("SELECT COUNT(*) n FROM cards WHERE run_id = ? AND section IN ('scripture','commentary')").get(deeper.body.runId) as any).n).toBe(0);
    const twice = await call("POST", `/api/studies/${studyId}/research`, { depth: "deeper" });
    expect(twice.status).toBe(409);

    // A new study of the same passage gets the saved research at once, with no model calls and nothing marked yet.
    const n = calls();
    const other = (await call("POST", "/api/studies", { ref: "Exodus 33:3", origin: "manual" })).body.id;
    const reused = await call("POST", `/api/studies/${other}/research`, { depth: "standard" });
    expect(reused.status).toBe(200);
    expect(reused.body.reused.studyId).toBe(studyId);
    expect(calls()).toBe(n);
    const a = (await call("GET", `/api/studies/${studyId}`)).body;
    const b = (await call("GET", `/api/studies/${other}`)).body;
    expect(b.cards.map((c: any) => c.title).sort()).toEqual(a.cards.map((c: any) => c.title).sort());
    expect(b.cards.every((c: any) => !c.selected)).toBe(true);
    expect(b.runs.every((r: any) => r.brief.reused_from?.study_id === studyId)).toBe(true);
    expect(b.runs.reduce((t: number, r: any) => t + r.usd_micros, 0)).toBe(0);
    expect(b.research).toEqual({ researched: true, deeperDone: true, missing: [], neutralReady: true, researchScope: "neutral" });
    expect((await call("POST", `/api/studies/${other}/research`, { depth: "standard" })).status).toBe(409);
    expect((await call("POST", `/api/studies/${other}/research`, { depth: "deeper" })).status).toBe(409);
    expect(calls()).toBe(n);
  });

  it("evidence shows the matched span in its source", async () => {
    const d = (await call("GET", `/api/studies/${studyId}`)).body;
    const voice = d.cards.find((c: any) => c.section === "commentary" && c.relationship === "direct_commentary");
    const evidence = (await call("GET", `/api/cards/${voice.id}/evidence`)).body.evidence;
    // One entry per source, even though the item cited it twice.
    expect(evidence).toHaveLength(1);
    const ev = evidence[0];
    expect(ev.matchSpan).not.toBeNull();
    expect(ev.window.text.slice(ev.matchSpan.start, ev.matchSpan.end)).toBe(voice.quotes[0]);
  });

  it("finds the Appendix F.3 draft's blockers: D3, D4, D5, D1", async () => {
    const f3 = `Can God's absence be an act of mercy? Exodus 33:3 (link, tag?) shows that God fulfills his covenant despite the Israelites breaking theirs. Augustine said: "". Calvin implied something else–that this was a test. In Exodus 33:15, Moses responds: "if you dont go with us, we won't go." For Moses, the land wasn't the promise. God himself was. We often feel sorry for Moses not getting to enter the promised land. But I think he God what he wanted–he remained in intimate fellowship with God.`;
    const r = await call("PUT", `/api/studies/${studyId}/working-text`, { format: "single", parts: [f3], source_reply: "", base_hash: null });
    expect(r.status).toBe(200);
    const codes = r.body.findings.deterministic.filter((f: any) => f.severity === "blocker").map((f: any) => f.code).sort();
    expect(codes).toEqual(["D1", "D3", "D4", "D5"]);
    const d5 = r.body.findings.deterministic.find((f: any) => f.code === "D5");
    expect(d5.repair).toContain("If Your Presence does not go with us");
    expect(r.body.gate.canPublish).toBe(false);
  });

  it("finds angles, each resting on an item of the brief", async () => {
    const r = await call("POST", `/api/studies/${studyId}/angles`, { previous: [] });
    expect(r.status).toBe(200);
    expect(r.body.angles[0].card.title).toBeTruthy();
    expect(r.body.angles[1].card).toBeNull();
    const req = modelRequests.findLast((m) => m.body.input[0].content.includes("looking for the angle"))!;
    expect(req.body.model).toBe("gpt-6-luna");
  });

  it("drafts from the research when the notebook is empty", async () => {
    // Notes are optional. Lines kept from the research (">") still aren't the user's words.
    await call("PATCH", `/api/studies/${studyId}`, { note: "> God's anger could destroy the people on the way, so he keeps his distance from them — Matthew Henry" });
    const r = await call("POST", `/api/studies/${studyId}/drafts`, { kind: "edit", format: "thread" });
    expect(r.status).toBe(200);
    const req = modelRequests.findLast((m) => m.body.input[0].content.includes("Write the user's post for X"))!;
    expect(req.body.input[0].content).toContain("The user hasn't written notes for this study");
    await call("PATCH", `/api/studies/${studyId}`, { note: "" });
  });

  it("drafts, checks, gates, and publishes through the composer", async () => {
    // The handle is blank by default; set one so links from other accounts are refused.
    expect((await call("PUT", "/api/preferences", { xHandle: "yourhandle" })).status).toBe(200);
    await call("PATCH", `/api/studies/${studyId}`, { first_observation: "God still gives the land after the golden calf, but not his presence." });
    await call("PATCH", `/api/studies/${studyId}`, { note: "Moses refuses to go without God. The land was never enough without the Giver himself." });
    const d0 = (await call("GET", `/api/studies/${studyId}`)).body;
    const voice = d0.cards.find((c: any) => c.section === "commentary" && c.relationship === "direct_commentary");
    await call("PATCH", `/api/cards/${voice.id}`, { selected: true });
    const dr = await call("POST", `/api/studies/${studyId}/drafts`, { kind: "edit", format: "thread" });
    expect(dr.status).toBe(200);
    // What the draft drew on resolves to real items; an opening equal to the first line isn't offered again.
    expect(dr.body.drew_on).toHaveLength(1);
    expect(dr.body.alternate_openings).toEqual(["Israel could have the land without God. Moses said no."]);
    expect(dr.body.left_out[0].reason).toMatch(/Its own post/);
    expect(dr.body.card_ids).toContain(voice.id);
    // The Scripture the user's notes draw on was found, read in the BSB, and given to the draft.
    expect(dr.body.drawn_on_scripture.map((x: any) => x.label)).toEqual(["Exodus 33:15"]);
    const draftReq = modelRequests.findLast((m) => m.body.input[0].content.includes("Write the user's post for X"))!;
    expect(draftReq.body.model).toBe("gpt-6.1-sol");
    expect(draftReq.body.input[0].content).toContain("Exodus 33:15 — ");
    expect(draftReq.body.input[0].content).toContain("Moses refuses to go without God.");
    const applied = await call("POST", `/api/studies/${studyId}/drafts/${dr.body.id}/apply`);
    expect(applied.body.working.parts).toHaveLength(2);
    expect(applied.body.gate.canPublish).toBe(false);
    expect(applied.body.gate.reasons.join()).toMatch(/Run Check/);

    // Sharpen proposes edits the user can take one at a time; it changes nothing on its own.
    const sh = await call("POST", `/api/studies/${studyId}/sharpen`);
    expect(sh.status).toBe(200);
    expect(sh.body.changes.map((c: any) => c.separable)).toEqual([true, true, false]);
    expect(sh.body.original).toEqual(applied.body.working.parts);
    expect(sh.body.base_hash).toBe(applied.body.working.text_hash);
    expect(modelRequests.findLast((m) => m.body.input[0].content.includes("Refine the user's current"))!.body.model).toBe("gpt-6.1-sol");

    const checked = await call("POST", `/api/studies/${studyId}/review`);
    expect(checked.status).toBe(200);
    expect(checked.body.gate.modelReview).toBe("current");
    const m7 = checked.body.findings.model.find((f: any) => f.code === "M7");
    const m9 = checked.body.findings.model.find((f: any) => f.code === "M9");
    expect(m7.severity).toBe("judgment");
    expect(m9.support.map((s: any) => s.ref)).toEqual(["EXO.33.15", "MAT.17.3"]);
    expect(checked.body.gate.canPublish).toBe(false);

    // Keeping a judgment needs a real reason.
    expect((await call("PATCH", `/api/findings/${m7.id}`, { resolution: "kept", reason: "fine" })).status).toBe(400);
    expect((await call("PATCH", `/api/findings/${m7.id}`, { resolution: "kept", reason: "This contrast is in the text itself." })).status).toBe(200);
    const g = (await call("GET", `/api/studies/${studyId}`)).body;
    expect(g.gate.canPublish).toBe(true);

    // A stale hash is refused.
    expect((await call("POST", `/api/studies/${studyId}/publish`, { confirm_text_hash: "nope" })).status).toBe(409);
    const pub = await call("POST", `/api/studies/${studyId}/publish`, { confirm_text_hash: g.working.text_hash });
    expect(pub.status).toBe(200);
    expect(pub.body.next.intentUrl).toMatch(/^https:\/\/x\.com\/intent\/tweet\?text=After\+the\+golden\+calf/);
    expect(pub.body.posts).toHaveLength(3);

    expect((await call("POST", `/api/posts/${pub.body.next.postId}/receipt`, { url: "https://x.com/someoneelse/status/123456789" })).status).toBe(400);
    const r1 = await call("POST", `/api/posts/${pub.body.next.postId}/receipt`, { url: "https://x.com/yourhandle/status/1900000000000000001" });
    expect(r1.body.next.intentUrl).toContain("in_reply_to=1900000000000000001");
    const r2 = await call("POST", `/api/posts/${r1.body.next.postId}/receipt`, { url: "https://twitter.com/YourHandle/status/1900000000000000002", published_text: "Something different" });
    expect(r2.body.posts[1].text_mismatch).toBe(1);
    const r3 = await call("POST", `/api/posts/${r2.body.next.postId}/skip`);
    expect(r3.body.done).toBe(true);
    const lib = (await call("GET", "/api/studies?q=Giver")).body;
    expect(lib.some((s: any) => s.id === studyId && s.status === "published")).toBe(true);
  });

  it("keeps a readable record, version history, and backups", async () => {
    // Posting writes the record without a Save.
    let posted: any;
    for (let i = 0; i < 40 && !posted?.record_path; i++) {
      await new Promise((r) => setTimeout(r, 25));
      posted = db.prepare("SELECT * FROM studies WHERE id = ?").get(studyId);
    }
    expect(posted.record_path).toMatch(/notes\/Exodus\/\d{4}-\d{2}-\d{2} Exodus 33\.3\.md$/);
    const postedMd = fs.readFileSync(posted.record_path, "utf8");
    expect(postedMd).toContain("## Posted to X");
    expect(postedMd).toContain("https://x.com/yourhandle/status/1900000000000000001");
    expect(postedMd).toContain("> **3** Go up to a land flowing with milk and honey");
    expect(postedMd).toContain(`id: ${studyId}`);

    // Save on an unposted study: status, file (a second study of the same passage on the same day gets its own file), and the draft in it.
    const s3 = (await call("POST", "/api/studies", { ref: "Exodus 33:3", origin: "manual" })).body.id;
    await call("PATCH", `/api/studies/${s3}`, { note: "First thought about withheld presence." });
    await call("PATCH", `/api/studies/${s3}`, { title: "Distance as mercy" });
    await call("PUT", `/api/studies/${s3}/working-text`, { format: "single", parts: ["Distance can be mercy."], source_reply: "", cause: "typing" });
    const saved = await call("POST", `/api/studies/${s3}/save`);
    expect(saved.status).toBe(200);
    expect(saved.body.study.status).toBe("saved");
    expect(saved.body.file).toMatch(/Exodus 33\.3 \(2\)\.md$/);
    const md = fs.readFileSync(saved.body.path, "utf8");
    expect(md).toContain("# Exodus 33:3 — Distance as mercy");
    expect(md).toContain("First thought about withheld presence.");
    expect(md).toContain("## The post (single post, not yet posted)");
    expect(md).toContain("Distance can be mercy.");

    // A later edit keeps the file current, at the same path.
    await call("PUT", `/api/studies/${s3}/working-text`, { format: "single", parts: ["Distance can be a mercy."], source_reply: "", cause: "undo" });
    await new Promise((r) => setTimeout(r, 100));
    expect(fs.readFileSync(saved.body.path, "utf8")).toContain("Distance can be a mercy.");
    const exp = await app.inject({ method: "GET", url: `/api/studies/${s3}/export.md`, headers: H });
    expect(exp.body).toBe(fs.readFileSync(saved.body.path, "utf8"));

    const hist = (await call("GET", `/api/studies/${s3}/history`)).body;
    expect(hist.note[0].note).toBe("First thought about withheld presence.");
    expect(hist.post.map((v: any) => v.parts[0])).toContain("Distance can be mercy.");

    const row = (await call("GET", "/api/studies")).body.find((r: any) => r.id === s3);
    expect(row).toMatchObject({ excerpt: "Distance can be a mercy.", excerptKind: "post", partCount: 1, hasRecord: true });

    const b = await call("POST", "/api/backups");
    expect(b.body.file).toMatch(/^personal-commentary-\d{4}-\d{2}-\d{2}\.db$/);
    const Database = (await import("better-sqlite3")).default;
    const copy = new Database(path.join(tmp, "backups", b.body.file), { readonly: true });
    expect((copy.prepare("SELECT COUNT(*) n FROM studies WHERE id = ?").get(s3) as any).n).toBe(1);
    copy.close();
  });

  it("records every model call in the cost ledger and enforces caps", async () => {
    const calls = (db.prepare("SELECT COUNT(*) n FROM llm_calls WHERE error IS NULL").get() as any).n;
    const ledger = (db.prepare("SELECT COUNT(*) n FROM cost_ledger WHERE vendor = 'openai'").get() as any).n;
    expect(ledger).toBe(calls);
    await call("PUT", "/api/preferences", { budgets: { perRunUsd: 0.01, perStudyUsd: 3, monthlyOpenaiUsd: 45, monthlyXUsd: 10 } });
    const s2 = (await call("POST", "/api/studies", { ref: "Exodus 33:4", origin: "manual" })).body.id;
    const run = await call("POST", `/api/studies/${s2}/research`, { depth: "standard" });
    expect(await waitForRun(run.body.runId)).toBe("partial");
    const stages = JSON.parse((db.prepare("SELECT stages_json FROM research_runs WHERE id = ?").get(run.body.runId) as any).stages_json);
    expect([stages.SA.error, stages.SB.error, stages.SC.error].join(" ")).toMatch(/per-run cap/);
  });

  it("marks interrupted runs failed on restart", async () => {
    const { recoverInterruptedRuns } = await import("../../server/pipeline.ts");
    db.prepare("INSERT INTO research_runs (id, study_id, depth, trigger, status, stages_json, prompt_version, queued_at) VALUES ('stuck', ?, 'standard', 'manual', 'running', '{}', 'x', ?)").run(studyId, new Date().toISOString());
    recoverInterruptedRuns(db);
    expect((db.prepare("SELECT status FROM research_runs WHERE id = 'stuck'").get() as any).status).toBe("failed");
  });
});
