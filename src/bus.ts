import type { Bus, BusEvent, Event } from "./types.js";
import type { Store } from "./store/db.js";

/**
 * In-process event bus. Every emitted event is also persisted to the `events` table
 * so the activity feed and SSE stream can replay it.
 */
export function createBus(db: Store): Bus {
  const handlers = new Map<string, Set<(ev: Event) => void>>();

  function dispatch(ev: Event) {
    for (const key of [ev.type, "*"]) {
      const set = handlers.get(key);
      if (!set) continue;
      for (const h of Array.from(set)) {
        try {
          h(ev);
        } catch (err) {
          console.error(`[bus] handler for ${key} threw`, err);
        }
      }
    }
  }

  return {
    emit(ev: BusEvent) {
      const stored = db.events.insert({
        type: ev.type,
        task_id: ev.task_id ?? null,
        item_id: ev.item_id ?? null,
        run_id: ev.run_id ?? null,
        payload: ev.payload ?? {},
      });
      // Deliver asynchronously so emitters never re-enter handlers mid-transaction.
      queueMicrotask(() => dispatch(stored));
    },
    on(type, handler) {
      let set = handlers.get(type);
      if (!set) handlers.set(type, (set = new Set()));
      set.add(handler);
      return () => {
        set!.delete(handler);
      };
    },
    waitFor(type, pred, timeoutMs) {
      return new Promise((resolve) => {
        let done = false;
        const off = this.on(type, (ev) => {
          if (done) return;
          if (pred(ev)) {
            done = true;
            clearTimeout(timer);
            off();
            resolve(ev);
          }
        });
        const timer = setTimeout(() => {
          if (done) return;
          done = true;
          off();
          resolve(null);
        }, timeoutMs);
      });
    },
  };
}
