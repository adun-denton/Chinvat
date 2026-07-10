import type { HubEvent } from './types.js';

type Listener = (evt: HubEvent) => void;

/** Tiny synchronous pub/sub. Listeners must not throw (guarded anyway). */
export class EventBus {
  private listeners = new Set<Listener>();

  on(cb: Listener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  emit(evt: HubEvent): void {
    for (const cb of this.listeners) {
      try {
        cb(evt);
      } catch (e) {
        process.stderr.write(`[chinvat] event listener error: ${e}\n`);
      }
    }
  }
}
