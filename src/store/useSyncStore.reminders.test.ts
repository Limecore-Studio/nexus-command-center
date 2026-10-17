import { describe, it, expect, beforeEach, vi } from 'vitest';

// v1.18.1 (NCC#186) — a successful pull re-arms task reminders (only when
// the tasks changed; reconcileTaskRemindersIfChanged decides), and only while
// the sync's own user is still signed in.

const h = vi.hoisted(() => ({
  user: { id: 'u-1' } as { id: string } | null,
  pullErrors: [] as string[],
  reconciles: [] as { tasks: unknown[]; stillCurrent: () => boolean }[],
  onPull: null as null | (() => void),
}));

vi.mock('../lib/cloudSync', () => ({
  fullSync: async () => {
    h.onPull?.();
    return { push: { errors: [] }, pull: { errors: h.pullErrors } };
  },
}));
vi.mock('../db/syncQueue', () => ({ listOwnPending: async () => [] }));
vi.mock('../lib/taskReminders', () => ({
  reconcileTaskRemindersIfChanged: async (tasks: unknown[], stillCurrent: () => boolean) => {
    h.reconciles.push({ tasks, stillCurrent });
    return true;
  },
}));
vi.mock('./useSessionStore', () => ({ useSessionStore: { getState: () => ({ user: h.user }) } }));
const loadable = { getState: () => ({ load: async () => {} }) };
vi.mock('./useFinanceStore', () => ({ useFinanceStore: loadable }));
vi.mock('./useStudiesStore', () => ({ useStudiesStore: loadable }));
vi.mock('./useFitnessStore', () => ({ useFitnessStore: loadable }));
vi.mock('./useGoalsStore', () => ({ useGoalsStore: loadable }));
vi.mock('./useBodyMetricsStore', () => ({ useBodyMetricsStore: loadable }));
vi.mock('./useWorkQualityStore', () => ({ useWorkQualityStore: loadable }));
vi.mock('./useBraindumpStore', () => ({ useBraindumpStore: loadable }));
const TASKS = [{ id: 't-1' }];
vi.mock('./useTaskStore', () => ({ useTaskStore: { getState: () => ({ load: async () => {}, tasks: TASKS }) } }));

vi.stubGlobal('navigator', { onLine: true });
const { useSyncStore } = await import('./useSyncStore');

beforeEach(() => {
  h.user = { id: 'u-1' };
  h.pullErrors = [];
  h.reconciles = [];
  h.onPull = null;
});

describe('task reminders after a pull (NCC#186)', () => {
  it('reconciles with the reloaded tasks, guarded on the same user', async () => {
    await useSyncStore.getState().syncNow();
    expect(h.reconciles).toHaveLength(1);
    expect(h.reconciles[0].tasks).toBe(TASKS);
    expect(h.reconciles[0].stillCurrent()).toBe(true);
    h.user = null; // signed out later: a loop still running stops
    expect(h.reconciles[0].stillCurrent()).toBe(false);
  });

  it('does not reconcile when the user signed out during the sync', async () => {
    h.onPull = () => {
      h.user = null;
    };
    await useSyncStore.getState().syncNow();
    expect(h.reconciles).toHaveLength(0);
  });

  it('does not reconcile after a failed pull', async () => {
    h.pullErrors = ['tasks: boom'];
    await useSyncStore.getState().syncNow();
    expect(h.reconciles).toHaveLength(0);
  });
});
