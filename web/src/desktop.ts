// The Mac app calls window.CommentaryDesktop.prepareToQuit() before it stops the server, so autosaves still
// waiting on their debounce timer land first. Each flusher resolves to false if its save failed.
const flushers = new Set<() => Promise<boolean>>();
const pendingChecks = new Set<() => boolean>();

export function onBeforeQuit(flush: () => Promise<boolean>, hasPending?: () => boolean) {
  flushers.add(flush);
  if (hasPending) pendingChecks.add(hasPending);
  return () => {
    flushers.delete(flush);
    if (hasPending) pendingChecks.delete(hasPending);
  };
}

// A browser reload cannot wait for an asynchronous save. Keep unsaved writing visible instead.
window.addEventListener("beforeunload", (event) => {
  if (![...pendingChecks].some((check) => check())) return;
  event.preventDefault();
  event.returnValue = "";
});

/** Save every mounted editor before changing views or using its text in research or drafting. */
export async function flushPendingChanges(): Promise<boolean> {
  return (await Promise.all([...flushers].map((f) => f().catch(() => false)))).every(Boolean);
}

(window as any).CommentaryDesktop = {
  prepareToQuit: flushPendingChanges,
};
