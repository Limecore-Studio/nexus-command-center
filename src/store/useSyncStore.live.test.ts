import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// v1.20 (NCC#221) — edits push a moment after they are made, a burst becomes
// one push, nothing ever pushes the queue twice at once, and a push hints the
// other devices with exactly the tables it wrote.

const h = vi.hoisted(() => ({
  user: { id: 'u-1' } as { id: string } | null,
  enqueued: null as null | (() => void),
  pushes: 0,
  fullSyncs: 0,
  pulls: [] as (string[] | undefined)[],
  inFlight: 0,
  maxInFlight: 0,
  pushedTables: ['transactions'] as string[],
  pushErrors: [] as unknown[],
}));

async function busy<T>(result: T): Promise<T> {
  h.inFlight++;
  h.maxInFlight = Math.max(h.maxInFlight, h.inFlight);
  await new Promise((r) => setTimeout(r, 50));
  h.inFlight--;
  return result;
}

vi.mock('../lib/cloudSync', () => ({
  pushQueue: async () => {
    h.pushes++;
    return busy({ attempted: 1, succeeded: 1, failed: 0, errors: h.pushErrors, pushedTables: h.pushedTables });
  },
  pullAll: async (_u: string, only?: ReadonlySet<string>) => {
    h.pulls.push(only ? [...only].sort() : undefined);
    return busy({ errors: [] });
  },
  fullSync: async () => {
    h.fullSyncs++;
    return busy({
      push: { attempted: 0, succeeded: 0, failed: 0, errors: [], pushedTables: ['grades'] },
      pull: { errors: [] },
    });
  },
}));
vi.mock('../db/syncQueue', () => ({
  listOwnPending: async () => [],
  onEnqueued: (l: () => void) => {
    h.enqueued = l;
    return () => {};
  },
}));
vi.mock('../lib/taskReminders', () => ({ reconcileTaskRemindersIfChanged: async () => true }));
vi.mock('./useSessionStore', () => ({ useSessionStore: { getState: () => ({ user: h.user }) } }));
const loadable = { getState: () => ({ load: async () => {} }) };
vi.mock('./useFinanceStore', () => ({ useFinanceStore: loadable }));
vi.mock('./useStudiesStore', () => ({ useStudiesStore: loadable }));
vi.mock('./useFitnessStore', () => ({ useFitnessStore: loadable }));
vi.mock('./useGoalsStore', () => ({ useGoalsStore: loadable }));
vi.mock('./useBodyMetricsStore', () => ({ useBodyMetricsStore: loadable }));
vi.mock('./useWorkQualityStore', () => ({ useWorkQualityStore: loadable }));
vi.mock('./useBraindumpStore', () => ({ useBraindumpStore: loadable }));
vi.mock('./useHabitsStore', () => ({ useHabitsStore: loadable }));
vi.mock('./useRecurringStore', () => ({ useRecurringStore: { getState: () => ({ materialize: async () => 0 }) } }));
vi.mock('./useTaskStore', () => ({ useTaskStore: { getState: () => ({ load: async () => {}, tasks: [] }) } }));

vi.stubGlobal('navigator', { onLine: true });
vi.stubGlobal('window', new EventTarget());
vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
const { useSyncStore, setPushAnnouncer, PUSH_DEBOUNCE_MS } = await import('./useSyncStore');
const { setAdoptionStatus } = await import('../lib/adoptionGate');

const announced: string[][] = [];
useSyncStore.getState().init();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  h.user = { id: 'u-1' };
  h.pushes = 0;
  h.fullSyncs = 0;
  h.pulls = [];
  h.inFlight = 0;
  h.maxInFlight = 0;
  h.pushedTables = ['transactions'];
  h.pushErrors = [];
  announced.length = 0;
  setPushAnnouncer((t) => announced.push(t));
  setAdoptionStatus('u-1', 'clear');
});
afterEach(() => {
  setPushAnnouncer(null);
  vi.useRealTimers();
});

describe('push right after an edit (NCC#221)', () => {
  it('20 enqueues within 300 ms produce one push run', async () => {
    for (let i = 0; i < 20; i++) {
      h.enqueued!();
      await vi.advanceTimersByTimeAsync(10);
    }
    expect(h.pushes).toBe(0);
    await vi.advanceTimersByTimeAsync(PUSH_DEBOUNCE_MS + 100);
    expect(h.pushes).toBe(1);
    expect(h.fullSyncs).toBe(0);
  });

  it('a push hints the tables it wrote', async () => {
    h.pushedTables = ['transactions', 'budget_categories'];
    h.enqueued!();
    await vi.advanceTimersByTimeAsync(PUSH_DEBOUNCE_MS + 100);
    expect(announced).toEqual([['transactions', 'budget_categories']]);
  });

  it('a push that wrote nothing hints nothing', async () => {
    h.pushedTables = [];
    h.pushErrors = [{ entityType: 'transaction', entityId: 'x', message: 'fail' }];
    h.enqueued!();
    await vi.advanceTimersByTimeAsync(PUSH_DEBOUNCE_MS + 100);
    expect(announced).toEqual([]);
    expect(useSyncStore.getState().lastError).toBe('1 item(s) failed to upload.');
  });

  it('the full sync hints its push too', async () => {
    const run = useSyncStore.getState().syncNow();
    await vi.advanceTimersByTimeAsync(200);
    await run;
    expect(announced).toEqual([['grades']]);
  });

  it('never pushes while a full sync is running, or the reverse', async () => {
    const full = useSyncStore.getState().syncNow();
    h.enqueued!();
    const pull = useSyncStore.getState().pullTables(['grades']);
    await vi.advanceTimersByTimeAsync(1000);
    await Promise.all([full, pull]);
    expect(h.fullSyncs).toBe(1);
    expect(h.pushes).toBe(1);
    expect(h.maxInFlight).toBe(1);
  });

  it('pushes nothing for a guest or before the adoption answer', async () => {
    h.user = null;
    h.enqueued!();
    await vi.advanceTimersByTimeAsync(PUSH_DEBOUNCE_MS + 100);
    h.user = { id: 'u-2' };
    setAdoptionStatus('u-2', 'ask');
    h.enqueued!();
    await vi.advanceTimersByTimeAsync(PUSH_DEBOUNCE_MS + 100);
    expect(h.pushes).toBe(0);
  });
});

describe('hinted pull (NCC#221)', () => {
  it('pulls only the named tables', async () => {
    const run = useSyncStore.getState().pullTables(['grades', 'subjects']);
    await vi.advanceTimersByTimeAsync(100);
    await run;
    expect(h.pulls).toEqual([['grades', 'subjects']]);
  });
});
