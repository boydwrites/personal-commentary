import { afterEach, describe, expect, it, vi } from "vitest";

async function browser() {
  vi.resetModules();
  const handlers = new Map<string, (event: any) => unknown>();
  const loc = { pathname: "/study/one", search: "", hash: "" };
  const move = (_state: unknown, _title: string, target: string) => {
    const url = new URL(target, "http://localhost");
    Object.assign(loc, { pathname: url.pathname, search: url.search, hash: url.hash });
  };
  const history = { pushState: vi.fn(move), replaceState: vi.fn(move) };
  vi.stubGlobal("location", loc);
  vi.stubGlobal("history", history);
  vi.stubGlobal("document", { querySelector: () => null });
  vi.stubGlobal("window", { addEventListener: (name: string, fn: (event: any) => unknown) => handlers.set(name, fn), scrollTo: vi.fn() });
  const api = await import("../../web/src/api.ts");
  const desktop = await import("../../web/src/desktop.ts");
  return { handlers, loc, history, api, desktop };
}

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

describe("navigation preserves pending writing", () => {
  it("waits for a save before an app link changes the route", async () => {
    const b = await browser();
    let resolve!: (saved: boolean) => void;
    b.desktop.onBeforeQuit(() => new Promise<boolean>((done) => { resolve = done; }));
    const moving = b.api.navigate("/library");
    expect(b.loc.pathname).toBe("/study/one");
    resolve(true);
    await moving;
    expect(b.loc.pathname).toBe("/library");
  });

  it("keeps the editor route when saving fails, including browser Back", async () => {
    const b = await browser();
    b.desktop.onBeforeQuit(async () => false);
    await b.api.navigate("/library");
    expect(b.loc.pathname).toBe("/study/one");
    b.loc.pathname = "/"; // The browser moves its URL before emitting popstate.
    await b.handlers.get("popstate")!({});
    expect(b.loc.pathname).toBe("/study/one");
  });

  it("the latest navigation wins when two links wait for the same save", async () => {
    const b = await browser();
    let resolve!: (saved: boolean) => void;
    const pending = new Promise<boolean>((done) => { resolve = done; });
    b.desktop.onBeforeQuit(() => pending);
    const first = b.api.navigate("/library");
    const second = b.api.navigate("/settings");
    resolve(true);
    await Promise.all([first, second]);
    expect(b.loc.pathname).toBe("/settings");
    expect(b.history.pushState).toHaveBeenCalledTimes(1);
  });

  it("only warns about reload when an editor actually has pending changes", async () => {
    const b = await browser();
    let dirty = true;
    const off = b.desktop.onBeforeQuit(async () => true, () => dirty);
    const event = { preventDefault: vi.fn(), returnValue: undefined as string | undefined };
    b.handlers.get("beforeunload")!(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    dirty = false;
    event.preventDefault.mockClear();
    b.handlers.get("beforeunload")!(event);
    expect(event.preventDefault).not.toHaveBeenCalled();
    off();
  });
});
