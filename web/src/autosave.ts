/** Serialize autosaves and retain failed changes. Newer fields win when patches overlap. */
export function createAutosaveQueue<T extends object>(write: (patch: T) => Promise<boolean>) {
  let pending: T | null = null;
  let inFlight: Promise<boolean> | null = null;

  const add = (patch: T) => {
    pending = { ...pending, ...patch };
  };
  const flush = (): Promise<boolean> => {
    if (inFlight) return inFlight;
    if (!pending) return Promise.resolve(true);
    inFlight = Promise.resolve().then(async () => {
      while (pending) {
        const patch = pending;
        pending = null;
        let ok = false;
        try {
          ok = await write(patch);
        } catch {
          ok = false;
        } finally {
          if (!ok) pending = { ...patch, ...(pending as T | null) };
        }
        if (!ok) return false;
      }
      return true;
    }).finally(() => { inFlight = null; });
    return inFlight;
  };
  return { add, flush, hasPending: () => pending !== null || inFlight !== null };
}
