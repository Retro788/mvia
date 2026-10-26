import type { BusEvents, IBus } from './types';

type Handler = (payload: never) => void;

export class Bus implements IBus {
  private handlers = new Map<keyof BusEvents, Set<Handler>>();

  on<K extends keyof BusEvents>(type: K, fn: (payload: BusEvents[K]) => void): () => void {
    let set = this.handlers.get(type);
    if (!set) this.handlers.set(type, (set = new Set()));
    set.add(fn as Handler);
    return () => set!.delete(fn as Handler);
  }

  emit<K extends keyof BusEvents>(type: K, payload: BusEvents[K]): void {
    const set = this.handlers.get(type);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        (fn as (p: BusEvents[K]) => void)(payload);
      } catch (err) {
        console.error(`[bus] handler for "${String(type)}" failed`, err);
      }
    }
  }
}
