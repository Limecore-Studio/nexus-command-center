// v1.22 (NCC#258) — notification ids assigned per device, not hashed.
//
// Task reminders, budget alerts and watchlist alerts took their id from a hash
// of the row's id modulo a small range (1000, 50, 50). Two rows often shared
// one id (about 17% of users with 20 dated tasks): the newer alarm replaced
// the older one, and cancelling either cancelled both. Habits had the same
// problem and moved to assigned slots in NCC#178; this is the same idea,
// shared by the three: a map rowId → slot in Capacitor Preferences, read once
// per run. A row gets its old hash slot when it is free, so an upgrade keeps
// most ids as they were, else the lowest free one; none when every slot is
// taken.
import { Preferences } from '@capacitor/preferences';

export interface SlotAllocator {
  /** The row's slot, assigned on first need; null when every slot is taken. */
  slotOf(id: string): Promise<number | null>;
  /** The row's slot if it has one; never assigns. */
  peek(id: string): Promise<number | undefined>;
  /** Gives the row's slot back. */
  free(id: string): Promise<void>;
  /** Forgets every assignment (after every alarm in the range was cancelled). */
  reset(): Promise<void>;
}

export function hashSlot(id: string, size: number): number {
  let hash = 0;
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return Math.abs(hash) % size;
}

export function slotAllocator(prefKey: string, size: number): SlotAllocator {
  let slots: Map<string, number> | undefined;
  let loading: Promise<Map<string, number>> | undefined;
  let saving: Promise<void> = Promise.resolve();

  const load = (): Promise<Map<string, number>> =>
    (loading ??= Preferences.get({ key: prefKey })
      .then(({ value }) => Object.entries((JSON.parse(value || '{}') ?? {}) as Record<string, unknown>))
      .catch(() => [] as [string, unknown][])
      .then((entries) => {
        const m = new Map<string, number>();
        const used = new Set<number>();
        // A slot listed twice keeps its first row; anything out of range goes.
        for (const [id, s] of entries) {
          if (typeof s !== 'number' || !Number.isInteger(s) || s < 0 || s >= size || used.has(s)) continue;
          m.set(id, s);
          used.add(s);
        }
        slots = m;
        return m;
      }));

  // Queued, so writes land in order, each with the map as it is when it runs.
  const save = () => {
    saving = saving
      .then(() => Preferences.set({ key: prefKey, value: JSON.stringify(Object.fromEntries(slots ?? [])) }))
      .catch((e) => console.warn('[notifSlots] not saved', prefKey, e));
    return saving;
  };

  return {
    async slotOf(id) {
      const m = await load();
      const held = m.get(id);
      if (held !== undefined) return held;
      const used = new Set(m.values());
      let s = hashSlot(id, size);
      for (let i = 0; used.has(s) && i < size; i++) s = i;
      if (used.has(s)) return null;
      m.set(id, s);
      await save();
      return s;
    },
    async peek(id) {
      return (await load()).get(id);
    },
    async free(id) {
      const m = await load();
      if (m.delete(id)) await save();
    },
    async reset() {
      const m = await load();
      if (m.size === 0) return;
      m.clear();
      await save();
    },
  };
}
