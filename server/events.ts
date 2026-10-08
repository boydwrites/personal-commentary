// Server-sent events: job progress, cost updates, notifications.
type Listener = (event: string, data: unknown) => void;
const listeners = new Set<Listener>();

export function subscribe(fn: Listener) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emit(event: string, data: unknown) {
  for (const fn of listeners) {
    try {
      fn(event, data);
    } catch {
      /* a dead stream is cleaned up by its own close handler */
    }
  }
}
