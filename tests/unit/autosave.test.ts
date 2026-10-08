import { describe, expect, it, vi } from "vitest";
import { createAutosaveQueue } from "../../web/src/autosave.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("note autosave before drafting", () => {
  it("waits for an in-flight save and the latest words before continuing", async () => {
    const first = deferred<boolean>();
    const write = vi.fn().mockImplementationOnce(() => first.promise).mockResolvedValue(true);
    const queue = createAutosaveQueue<{ note?: string; question?: string }>(write);
    expect(queue.hasPending()).toBe(false);
    queue.add({ note: "first words" });
    expect(queue.hasPending()).toBe(true);
    const autosave = queue.flush();
    await Promise.resolve();
    queue.add({ note: "latest words", question: "Why?" });
    const beforeDraft = queue.flush();
    expect(write).toHaveBeenCalledTimes(1);
    expect(beforeDraft).toBe(autosave);
    first.resolve(true);
    expect(await beforeDraft).toBe(true);
    expect(queue.hasPending()).toBe(false);
    expect(write.mock.calls).toEqual([[{ note: "first words" }], [{ note: "latest words", question: "Why?" }]]);
  });

  it("reports failure and retains unsaved fields without replacing newer words", async () => {
    const first = deferred<boolean>();
    const write = vi.fn().mockImplementationOnce(() => first.promise).mockResolvedValue(true);
    const queue = createAutosaveQueue<{ note?: string; question?: string }>(write);
    queue.add({ note: "old words", question: "Kept question" });
    const saving = queue.flush();
    await Promise.resolve();
    queue.add({ note: "newer words" });
    first.resolve(false);
    expect(await saving).toBe(false);
    expect(queue.hasPending()).toBe(true);
    expect(await queue.flush()).toBe(true);
    expect(queue.hasPending()).toBe(false);
    expect(write).toHaveBeenLastCalledWith({ note: "newer words", question: "Kept question" });
  });

  it("retains a thrown save for a later retry", async () => {
    const write = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(true);
    const queue = createAutosaveQueue<{ note: string }>(write);
    queue.add({ note: "keep this" });
    expect(await queue.flush()).toBe(false);
    expect(await queue.flush()).toBe(true);
    expect(write).toHaveBeenLastCalledWith({ note: "keep this" });
  });
});
