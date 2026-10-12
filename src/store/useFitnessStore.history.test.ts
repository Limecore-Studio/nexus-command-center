import { describe, it, expect, vi } from 'vitest';

// v1.18.1 (NCC#153) — the workout list the goals and reviews read was capped
// at the 20 newest sessions: a "30 workouts" goal never completed and a PR
// set before the 20th-newest session read as 0.

vi.mock('@capacitor/preferences', () => ({
  Preferences: { get: async () => ({ value: null }), set: async () => {}, remove: async () => {} },
}));
vi.mock('../lib/supabase', () => ({ supabase: {} }));
vi.mock('../utils/healthConnect', () => ({
  healthCapability: async () => ({ available: false, reason: '' }),
  hasHealthPermissions: async () => false,
  requestHealthPermissions: async () => false,
  readTodaySteps: async () => null,
  readWeeklySteps: async () => null,
  readLatestWeightKg: async () => null,
}));

const { db } = await import('../db/database');
const { useFitnessStore } = await import('./useFitnessStore');
const { computeGoalProgress } = await import('../lib/goals');

describe('workouts the goals see (NCC#153)', () => {
  it('include every session, with its sets', async () => {
    // 40 workouts, one every 2 days from 2026-07-01; the oldest holds the PR.
    const sessions = Array.from({ length: 40 }, (_, i) => ({
      id: crypto.randomUUID(),
      sessionType: 'Push Day',
      date: new Date(Date.UTC(2026, 6, 1 + i * 2, 10)).toISOString(),
      sets: [],
      syncStatus: 'synced' as const,
      createdAt: '2026-07-01T00:00:00Z',
    }));
    await db.workoutSessions.bulkPut(sessions);
    await db.workoutSets.put({ id: crypto.randomUUID(), sessionId: sessions[0].id, exercise: 'Bench', weightKg: 120, reps: 1, createdAt: 'x' } as any);
    await useFitnessStore.getState().load();
    const ws = useFitnessStore.getState().sessions;
    expect(ws).toHaveLength(40);
    expect(ws[0].date > ws[39].date).toBe(true); // newest first, as before
    expect(ws.find((s) => s.id === sessions[0].id)?.sets).toHaveLength(1);

    const base = { transactions: [], holdings: [], manualAssets: [], stockQuotes: {}, cryptoPrices: {}, fxRates: {}, baseCurrency: 'EUR', tasks: [], studySessions: [], workouts: ws, currentGpa: null } as any;
    const count = computeGoalProgress({ id: 'g', title: '30 workouts', goalType: 'workout_count', targetValue: 30, startDate: '2026-07-01', completed: false, syncStatus: 'synced', createdAt: 'x' } as any, base);
    const pr = computeGoalProgress({ id: 'g2', title: 'Bench 120', goalType: 'lift_pr', targetValue: 120, exerciseName: 'Bench', startDate: '2026-07-01', completed: false, syncStatus: 'synced', createdAt: 'x' } as any, base);
    expect(count.reached).toBe(true);
    expect(pr.currentValue).toBe(120);
  });
});
