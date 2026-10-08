// One save state for the whole study. Every editor (the notes, the title, the piece) reports here, and the
// study header shows the least settled of them: a failure beats saving, saving beats waiting, and waiting beats saved.
import { useSyncExternalStore } from "react";

export type SaveState = "saved" | "pending" | "saving" | "failed";

const RANK: Record<SaveState, number> = { saved: 0, pending: 1, saving: 2, failed: 3 };
const states = new Map<string, SaveState>();
const subs = new Set<() => void>();
let current: SaveState = "saved";

function settle() {
  let worst: SaveState = "saved";
  for (const s of states.values()) if (RANK[s] > RANK[worst]) worst = s;
  if (worst === current) return;
  current = worst;
  subs.forEach((f) => f());
}

/** An editor reports its state; "saved" (or null, when it unmounts) removes it. */
export function reportSave(key: string, state: SaveState | null) {
  if (!state || state === "saved") states.delete(key);
  else states.set(key, state);
  settle();
}

export function useSaveState(): SaveState {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => current,
  );
}
