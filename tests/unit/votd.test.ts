import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import fs from "node:fs";
import path from "node:path";
import { openDb, localDate, nowIso, sha256, type DB } from "../../server/db.ts";
import { CACHE_DIR } from "../../server/config.ts";
import { setPrefs } from "../../server/prefs.ts";
import { DISCOVERY_PASSAGES, getVerseOfTheDay, localDailyPassage, shufflePassage } from "../../server/votd.ts";
import { registerRoutes } from "../../server/routes.ts";
import type { PassageRange } from "../../shared/refs.ts";

// These tests exercise daily retrieval and routing without installing the entire Bible dataset.
vi.mock("../../server/bible.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../server/bible.ts")>();
  return {
    ...actual,
    expandRange: (r: PassageRange) => r.c1 > 150 || (r.v1 ?? 1) > 176
      ? { ok: false, error: "Outside the recorded verse counts." }
      : { ok: true, range: { ...r, v1: r.v1 ?? 1, v2: r.v2 ?? 6 } },
    getChapter: async () => ({ verses: [{ n: 10, text: "Create in me a clean heart, O God, and renew a right spirit within me." }], headings: [] }),
  };
});

let db: DB;
let calls: string[];
const url = "https://www.bible.com/verse-of-the-day";
const page = fs.readFileSync(path.join(__dirname, "../fixtures/bible-com-votd.html"), "utf8");
let biblePage: string | null;
let mannaRef: string | null;

beforeEach(() => {
  db = openDb(":memory:");
  calls = [];
  biblePage = page;
  mannaRef = "James 1:22";
  vi.stubGlobal("fetch", vi.fn(async (request: string) => {
    calls.push(request);
    if (request.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /", { headers: { "content-type": "text/plain" } });
    if (request === url) return new Response(biblePage ?? "Unavailable", { status: biblePage === null ? 503 : 200, headers: { "content-type": "text/html" } });
    if (request.startsWith("https://beta.ourmanna.com/")) return new Response(JSON.stringify({ verse: { details: { reference: mannaRef } } }), { status: mannaRef === null ? 503 : 200, headers: { "content-type": "application/json" } });
    throw new Error(`Unexpected network request: ${request}`);
  }));
});
afterEach(() => { db.close(); vi.unstubAllGlobals(); });

function saveStudy(id: string, ref: string, status: "open" | "saved" = "open") {
  db.prepare(`INSERT INTO studies (id, primary_ref, display_ref, ref_start_ord, ref_end_ord, translation_id, origin, status, created_local_date, created_at, updated_at)
    VALUES (?, ?, ?, 2033003, 2033003, 'BSB', 'manual', ?, ?, ?, ?)`).run(id, ref, ref, status, localDate(), nowIso(), nowIso());
}

describe("daily reading", () => {
  it("bypasses stale HTTP content, caches a local day, and shares concurrent requests", async () => {
    const cacheFile = path.join(CACHE_DIR, sha256(url) + ".json");
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify({ fetchedAt: nowIso(), res: { body: "<title>Verse of the Day - John 3:16 - Bible App</title>" } }));
    try {
      const both = await Promise.all([getVerseOfTheDay(db, "2026-10-04"), getVerseOfTheDay(db, "2026-10-04")]);
      expect(both).toEqual([{ ref: "PSA.51.10", source: "bible.com" }, { ref: "PSA.51.10", source: "bible.com" }]);
      biblePage = "<title>Verse of the Day - Exodus 20:8 - Bible App</title>";
      expect(await getVerseOfTheDay(db, "2026-10-04")).toEqual(both[0]);
      expect(calls.filter((call) => call === url)).toHaveLength(1);
      expect(await getVerseOfTheDay(db, "2026-10-05")).toEqual({ ref: "EXO.20.8", source: "bible.com" });
      expect(calls.filter((call) => call === url)).toHaveLength(2);
    } finally { fs.rmSync(cacheFile, { force: true }); }
  });

  it("falls through malformed or invalid feed references and labels OurManna correctly", async () => {
    biblePage = "<title>Verse of the Day - John 999:999 - Bible App</title>";
    expect(await getVerseOfTheDay(db, "2026-10-04")).toEqual({ ref: "JAS.1.22", source: "ourmanna" });
  });

  it("keeps working offline with a stable daily local passage and no repeat tomorrow", async () => {
    biblePage = null;
    mannaRef = null;
    const first = await getVerseOfTheDay(db, "2026-10-04");
    expect(first).toEqual({ ref: localDailyPassage("2026-10-04"), source: "local" });
    expect(await getVerseOfTheDay(db, "2026-10-04")).toEqual(first);
    const next = await getVerseOfTheDay(db, "2026-10-05");
    expect(next.source).toBe("local");
    expect(next.ref).not.toBe(first.ref);
    expect((db.prepare("SELECT COUNT(*) n FROM studies").get() as any).n).toBe(0);
  });

  it("rejects yesterday's reference even when both feeds return it", async () => {
    await getVerseOfTheDay(db, "2026-10-04");
    mannaRef = "Psalm 51:10";
    const next = await getVerseOfTheDay(db, "2026-10-05");
    expect(next.source).toBe("local");
    expect(next.ref).not.toBe("PSA.51.10");
  });

  it("repairs an already cached duplicate without changing other cached days", async () => {
    for (const date of ["2026-10-03", "2026-10-04"]) {
      db.prepare("INSERT INTO votd_days (local_date, source, passage_id, canonical_ref, fetched_at) VALUES (?, 'bible.com', 'PSA.51.10', 'PSA.51.10', ?)").run(date, nowIso());
    }
    expect(await getVerseOfTheDay(db, "2026-10-04")).toEqual({ ref: "JAS.1.22", source: "ourmanna" });
    expect(await getVerseOfTheDay(db, "2026-10-03")).toEqual({ ref: "PSA.51.10", source: "bible.com" });
    expect(await getVerseOfTheDay(db, "2026-10-04")).toEqual({ ref: "JAS.1.22", source: "ourmanna" });
    expect(calls.filter((call) => call === url)).toHaveLength(1);
  });

  it("rotates across DST and the year boundary without consecutive repeats", () => {
    for (const dates of [["2026-10-31", "2026-11-01", "2026-11-02"], ["2026-12-31", "2027-01-01"]]) {
      expect(new Set(dates.map((date) => localDailyPassage(date))).size).toBe(dates.length);
    }
    const ref = localDailyPassage("2026-10-04");
    expect(localDailyPassage("2026-10-04", ref)).not.toBe(ref);
  });
});

describe("Today and shuffle", () => {
  it("always returns today's verse alongside a separate open study and Sunday passage", async () => {
    saveStudy("yesterday", "EXO.33.3");
    setPrefs(db, { sundayText: { ref: "John 3:16", date: "2099-10-04" }, passageOrder: ["open", "sunday", "votd"] });
    const app = Fastify();
    registerRoutes(app, db);
    try {
      const response = await app.inject({ method: "GET", url: "/api/today" });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ date: localDate(), proposal: { ref: "PSA.51.10", origin: "votd", source: "bible.com" }, open: { id: "yesterday" }, sunday: { ref: "JHN.3.16", origin: "sunday_text" } });
      expect((db.prepare("SELECT COUNT(*) n FROM studies").get() as any).n).toBe(1);
      expect((db.prepare("SELECT COUNT(*) n FROM research_runs").get() as any).n).toBe(0);
    } finally { await app.close(); }
  });

  it("shuffles curated and saved passages without creating studies, research, or network traffic", async () => {
    saveStudy("saved", "EXO.33.3", "saved");
    expect(shufflePassage(db, [...DISCOVERY_PASSAGES], () => 0)).toEqual({ ref: "EXO.33.3", source: "library" });
    const excluded = [...DISCOVERY_PASSAGES, "EXO.33.3"];
    expect(shufflePassage(db, excluded, () => 0).ref).not.toBe("EXO.33.3");
    const app = Fastify();
    registerRoutes(app, db);
    try {
      const response = await app.inject({ method: "GET", url: `/api/verses/shuffle?exclude=${encodeURIComponent(DISCOVERY_PASSAGES.join(","))}` });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ proposal: { ref: "EXO.33.3", source: "library", origin: "manual" } });
      expect((db.prepare("SELECT COUNT(*) n FROM studies").get() as any).n).toBe(1);
      expect((db.prepare("SELECT COUNT(*) n FROM research_runs").get() as any).n).toBe(0);
      expect(calls).toEqual([]);
    } finally { await app.close(); }
  });
});
