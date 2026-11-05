import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeClient, makeUuids } from '../test/fakePostgrest';

// v1.16 (limecore#28) — the real `pullAll`, against a PostgREST stand-in that
// truncates at 1000 rows without an error, the way the real one does.
//
// The case that made this P1: after pulling `workout_sessions`, `pullAll`
// DELETES every synced local session absent from the pull and cascades to its
// sets. Before v1.16 the pull was a bare `select('*')`, so for a user with more
// than 1000 sessions, every session past the cap was deleted from this device
// on every pull, as if LimeLog had deleted it upstream.

const holder = vi.hoisted(() => ({ client: null as any }));
vi.mock('./supabase', () => ({
  get supabase() {
    return holder.client;
  },
}));

const { pullAll } = await import('./cloudSync');
const { db } = await import('../db/database');

const USER = 'user-1';

function workouts(n: number) {
  const ids = makeUuids(n);
  const cloudSessions = ids.map((id, i) => ({
    id,
    user_id: USER,
    session_type: 'strength',
    date: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`,
    notes: null,
    created_at: '2026-01-01T00:00:00Z',
    deleted_at: null,
  }));
  const cloudSets = ids.map((sessionId) => ({
    id: crypto.randomUUID(),
    user_id: USER,
    session_id: sessionId,
    exercise: 'Squat',
    weight_kg: 100,
    reps: 5,
    rpe: null,
    created_at: '2026-01-01T00:00:00Z',
  }));
  const localSessions = ids.map((id, i) => ({
    id,
    sessionType: 'strength',
    date: cloudSessions[i].date,
    sets: [],
    syncStatus: 'synced' as const,
    createdAt: '2026-01-01T00:00:00Z',
  }));
  const localSets = cloudSets.map((s) => ({
    id: s.id,
    sessionId: s.session_id,
    exercise: s.exercise,
    weightKg: 100,
    reps: 5,
    createdAt: s.created_at,
  }));
  return { cloudSessions, cloudSets, localSessions, localSets };
}

beforeEach(async () => {
  holder.client = null;
  await Promise.all(db.tables.map((t) => t.clear()));
});

describe('pullAll', () => {
  it('pages every table it reads', async () => {
    // Structural guard: a table added to the pull later with a bare
    // `select('*')` makes a request with no keyset order and fails here,
    // whatever it is called and however small it is when it is added.
    holder.client = fakeClient({});
    await pullAll(USER);
    const tables = new Set(holder.client.requests.map((r: any) => r.table));
    const unpaged = holder.client.requests.filter((r: any) => r.order?.col !== 'id');
    expect(unpaged.map((r: any) => r.table)).toEqual([]);
    // Sanity: the guard is looking at the real pull, not an empty one.
    for (const t of ['workout_sessions', 'workout_sets', 'transactions', 'habits', 'subjects', 'grades']) {
      expect(tables).toContain(t);
    }
  });

  it('keeps every workout past the 1000-row cap instead of pruning it', async () => {
    const w = workouts(1200);
    await db.workoutSessions.bulkPut(w.localSessions as any);
    await db.workoutSets.bulkPut(w.localSets as any);
    holder.client = fakeClient({ workout_sessions: w.cloudSessions, workout_sets: w.cloudSets });

    const result = await pullAll(USER);

    expect(result.errors).toEqual([]);
    expect(await db.workoutSessions.count()).toBe(1200);
    expect(await db.workoutSets.count()).toBe(1200);
    // 1,200 rows through fake-indexeddb take ~2 s locally and went past vitest's
    // 5 s default on a loaded CI runner (NCC#120). The bound is for hangs only.
  }, 30_000);

  it('prunes nothing when a later page fails — a partial pull is never treated as complete', async () => {
    const w = workouts(1200);
    await db.workoutSessions.bulkPut(w.localSessions as any);
    await db.workoutSets.bulkPut(w.localSets as any);
    holder.client = fakeClient(
      { workout_sessions: w.cloudSessions, workout_sets: w.cloudSets },
      {
        failWhen: (req) =>
          req.table === 'workout_sessions' && req.gt
            ? { code: '57014', message: 'canceling statement due to statement timeout' }
            : null,
      },
    );

    const result = await pullAll(USER);

    expect(result.errors.some((e) => e.startsWith('workout_sessions:'))).toBe(true);
    expect(await db.workoutSessions.count()).toBe(1200);
    expect(await db.workoutSets.count()).toBe(1200);
  });

  it('still prunes a session that really was deleted upstream', async () => {
    // The prune is kept, not disabled: with a complete pull it does its job.
    const w = workouts(3);
    await db.workoutSessions.bulkPut(w.localSessions as any);
    await db.workoutSets.bulkPut(w.localSets as any);
    const [gone, ...kept] = w.cloudSessions;
    holder.client = fakeClient({
      workout_sessions: kept,
      workout_sets: w.cloudSets.filter((s) => s.session_id !== gone.id),
    });

    await pullAll(USER);

    expect((await db.workoutSessions.toArray()).map((s) => s.id).sort()).toEqual(kept.map((s) => s.id).sort());
    expect(await db.workoutSets.where('sessionId').equals(gone.id).count()).toBe(0);
  });
});

// v1.20 (NCC#221) — a live-sync hint pulls only the tables it names.
describe('pullAll with a table filter', () => {
  const requested = () => new Set((holder.client.requests as { table: string }[]).map((r) => r.table));

  it('selects only the named table', async () => {
    holder.client = fakeClient({ transactions: [] });
    await pullAll(USER, new Set(['transactions']));
    expect(requested()).toEqual(new Set(['transactions']));
  });

  it('a table read together with others brings its group', async () => {
    holder.client = fakeClient({ subjects: [], grades: [], study_sessions: [] });
    await pullAll(USER, new Set(['grades']));
    expect(requested()).toEqual(new Set(['subjects', 'grades', 'study_sessions']));
  });

  it('without a filter, every table is read', async () => {
    holder.client = fakeClient({});
    await pullAll(USER);
    expect(requested().size).toBeGreaterThanOrEqual(21);
  });
});
