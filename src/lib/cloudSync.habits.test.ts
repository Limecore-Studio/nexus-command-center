import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeClient } from '../test/fakePostgrest';
import { legacyIdToUuid } from '../utils/uuid';

// v1.16 (NCC#58, part 1) — a habit completion is ONE fact per (habit, day).
// Against a stand-in that enforces `UNIQUE (habit_id, date)` the way Postgres
// does. Before this fix, the second device to mark a habit on a given day hit
// 23505, which `pushQueue` classes as permanent — the item was dropped with no
// retry — and the pull then left both local rows in place, counting the day
// twice.

const holder = vi.hoisted(() => ({ client: null as any }));
vi.mock('./supabase', () => ({
  get supabase() {
    return holder.client;
  },
}));

const { pushQueue, hydrateHabitsFromCloud } = await import('./cloudSync');
const { db } = await import('../db/database');

const USER = 'user-1';
const HABIT = crypto.randomUUID();
const DAY = '2026-09-21';
const T0 = '2026-09-21T08:00:00Z';

const uniques = { habit_completions: [['habit_id', 'date']] };

function serverCompletion(id: string, amount = 1, date = DAY) {
  return { id, habit_id: HABIT, user_id: USER, date, amount, created_at: T0 };
}
function localCompletion(id: string, amount = 1, date = DAY, syncStatus: 'synced' | 'pending' = 'synced', habitId = HABIT) {
  return { id, habitId, date, amount, syncStatus, createdAt: T0 };
}
async function queue(operation: 'insert' | 'update' | 'delete', entityId: string, payload: object) {
  await db.syncQueue.add({
    id: crypto.randomUUID(),
    entityType: 'habit_completion',
    entityId,
    operation,
    payload: JSON.stringify(payload),
    createdAt: T0,
  });
}

beforeEach(async () => {
  holder.client = null;
  await Promise.all(db.tables.map((t) => t.clear()));
});

describe('pushHabitCompletion — the second device on the same day', () => {
  it('applies its amount to the existing row instead of being dropped', async () => {
    const [deviceA, deviceB] = [crypto.randomUUID(), crypto.randomUUID()];
    holder.client = fakeClient({ habit_completions: [serverCompletion(deviceA, 1)] }, { uniques });
    await queue('insert', deviceB, localCompletion(deviceB, 3, DAY, 'pending'));

    const result = await pushQueue(USER);

    expect(result.errors).toEqual([]);
    expect(result.succeeded).toBe(1);
    const rows = holder.client.tables.habit_completions;
    expect(rows).toHaveLength(1);
    // The server row keeps its own id — no primary-key rewrite to ping-pong.
    expect(rows[0]).toMatchObject({ id: deviceA, amount: 3 });
  });

  it('still inserts normally when the day is free', async () => {
    const id = crypto.randomUUID();
    holder.client = fakeClient({ habit_completions: [] }, { uniques });
    await queue('insert', id, localCompletion(id, 2, DAY, 'pending'));
    await pushQueue(USER);
    expect(holder.client.tables.habit_completions).toEqual([
      expect.objectContaining({ id, habit_id: HABIT, date: DAY, amount: 2 }),
    ]);
  });

  it('does not rewrite the id even on a plain update of the same day', async () => {
    const [deviceA, deviceB] = [crypto.randomUUID(), crypto.randomUUID()];
    holder.client = fakeClient({ habit_completions: [serverCompletion(deviceA, 1)] }, { uniques });
    await queue('update', deviceB, localCompletion(deviceB, 5, DAY, 'pending'));
    await pushQueue(USER);
    expect(holder.client.tables.habit_completions).toEqual([
      expect.objectContaining({ id: deviceA, amount: 5 }),
    ]);
  });
});

// v1.20 (NCC#92): un-marking a day is a tombstone, so the user's other
// devices clear it too; before the migration adds `deleted_at`, the hard
// delete of old.
describe('pushHabitCompletion — un-marking a day', () => {
  const live = () => holder.client.tables.habit_completions.filter((r: any) => !r.deleted_at);

  it('clears the day even when the server knows it under another id', async () => {
    const [deviceA, deviceB] = [crypto.randomUUID(), crypto.randomUUID()];
    holder.client = fakeClient({ habit_completions: [serverCompletion(deviceA)] }, { uniques });
    await queue('delete', deviceB, { id: deviceB, habitId: HABIT, date: DAY });
    await pushQueue(USER);
    expect(live()).toEqual([]);
    expect(holder.client.tables.habit_completions[0]).toMatchObject({ id: deviceA, deleted_at: expect.any(String) });
  });

  it('only clears that day, not the habit\'s other days', async () => {
    const other = crypto.randomUUID();
    const target = crypto.randomUUID();
    holder.client = fakeClient(
      { habit_completions: [serverCompletion(target), serverCompletion(other, 1, '2026-09-22')] },
      { uniques },
    );
    await queue('delete', target, { id: target, habitId: HABIT, date: DAY });
    await pushQueue(USER);
    expect(live().map((r: any) => r.id)).toEqual([other]);
  });

  it('still honours a delete queued by an older build, which carries only the id', async () => {
    const id = crypto.randomUUID();
    holder.client = fakeClient({ habit_completions: [serverCompletion(id)] }, { uniques });
    await queue('delete', id, { id });
    await pushQueue(USER);
    expect(live()).toEqual([]);
    expect(holder.client.writes[0].filters).toEqual([['eq', 'id', id]]);
  });

  it('hard-deletes before the migration adds the column', async () => {
    const id = crypto.randomUUID();
    holder.client = fakeClient({ habit_completions: [serverCompletion(id)] },
      { uniques, unknownColumns: { habit_completions: ['deleted_at'] } });
    await queue('delete', id, { id, habitId: HABIT, date: DAY });
    await pushQueue(USER);
    expect(holder.client.tables.habit_completions).toEqual([]);
  });
});

describe('pushHabitCompletion — re-marking a cleared day (v1.20, NCC#92)', () => {
  it('revives the cleared row, under the server\'s id', async () => {
    const [server, local] = [crypto.randomUUID(), crypto.randomUUID()];
    holder.client = fakeClient({ habit_completions: [{ ...serverCompletion(server), deleted_at: T0 }] }, { uniques });
    await queue('insert', local, localCompletion(local, 1));
    await pushQueue(USER);
    expect(holder.client.tables.habit_completions).toHaveLength(1);
    expect(holder.client.tables.habit_completions[0]).toMatchObject({ id: server, deleted_at: null, amount: 1 });
  });

  it('marks normally before the migration adds the column', async () => {
    const id = crypto.randomUUID();
    holder.client = fakeClient({ habit_completions: [] },
      { uniques, unknownColumns: { habit_completions: ['deleted_at'] } });
    await queue('insert', id, localCompletion(id, 2));
    await pushQueue(USER);
    expect(holder.client.tables.habit_completions).toEqual([expect.objectContaining({ id, amount: 2 })]);
    expect(holder.client.tables.habit_completions[0]).not.toHaveProperty('deleted_at');
  });
});

describe('pushHabit — deleting a habit (v1.20, NCC#92)', () => {
  async function queueHabitDelete(id: string) {
    await db.syncQueue.add({
      id: crypto.randomUUID(), entityType: 'habit', entityId: id, operation: 'delete',
      payload: JSON.stringify({ id }), createdAt: T0,
    });
  }

  it('tombstones the habit and its days, leaving other habits alone', async () => {
    const otherHabit = crypto.randomUUID();
    holder.client = fakeClient({
      habits: [{ id: HABIT, user_id: USER, title: 'Read' }, { id: otherHabit, user_id: USER, title: 'Run' }],
      habit_completions: [serverCompletion(crypto.randomUUID()), { ...serverCompletion(crypto.randomUUID()), habit_id: otherHabit }],
    }, { uniques });
    await queueHabitDelete(HABIT);
    await pushQueue(USER);
    const habits = holder.client.tables.habits;
    expect(habits.find((h: any) => h.id === HABIT).deleted_at).toEqual(expect.any(String));
    expect(habits.find((h: any) => h.id === otherHabit).deleted_at).toBeUndefined();
    const days = holder.client.tables.habit_completions;
    expect(days.find((c: any) => c.habit_id === HABIT).deleted_at).toEqual(expect.any(String));
    expect(days.find((c: any) => c.habit_id === otherHabit).deleted_at).toBeUndefined();
  });

  it('hard-deletes both before the migration adds the column', async () => {
    holder.client = fakeClient({
      habits: [{ id: HABIT, user_id: USER, title: 'Read' }],
      habit_completions: [serverCompletion(crypto.randomUUID())],
    }, { uniques, unknownColumns: { habits: ['deleted_at'], habit_completions: ['deleted_at'] } });
    await queueHabitDelete(HABIT);
    await pushQueue(USER);
    expect(holder.client.tables.habits).toEqual([]);
    expect(holder.client.tables.habit_completions).toEqual([]);
  });
});

describe('hydrateHabitsFromCloud — one local row per (habit, day)', () => {
  it('replaces this device\'s row for a day with the server\'s', async () => {
    const [deviceA, deviceB] = [crypto.randomUUID(), crypto.randomUUID()];
    await db.habitCompletions.put(localCompletion(deviceB, 3) as any);
    holder.client = fakeClient({ habits: [], habit_completions: [serverCompletion(deviceA, 3)] });

    await hydrateHabitsFromCloud(USER);

    const local = await db.habitCompletions.toArray();
    expect(local.map((c) => c.id)).toEqual([deviceA]);
  });

  it('collapses a row held under its legacy id onto the pulled uuid row', async () => {
    const legacy = 'completion-1700000000000';
    await db.habitCompletions.put(localCompletion(legacy) as any);
    holder.client = fakeClient({ habits: [], habit_completions: [serverCompletion(legacyIdToUuid(legacy))] });

    await hydrateHabitsFromCloud(USER);

    expect((await db.habitCompletions.toArray()).map((c) => c.id)).toEqual([legacyIdToUuid(legacy)]);
  });

  it('leaves other days and not-yet-pushed completions alone', async () => {
    const server = crypto.randomUUID();
    const otherDay = crypto.randomUUID();
    const unpushed = crypto.randomUUID();
    await db.habitCompletions.bulkPut([
      localCompletion(otherDay, 1, '2026-09-20'),
      localCompletion(unpushed, 1, '2026-09-23', 'pending'),
    ] as any);
    holder.client = fakeClient({ habits: [], habit_completions: [serverCompletion(server)] });

    await hydrateHabitsFromCloud(USER);

    expect((await db.habitCompletions.toArray()).map((c) => c.id).sort()).toEqual(
      [server, otherDay, unpushed].sort(),
    );
  });
});

describe('hydrateHabitsFromCloud — tombstones (v1.20, NCC#92)', () => {
  it('a habit deleted elsewhere leaves this device', async () => {
    await db.habits.put({ id: HABIT, title: 'Read', type: 'binary', frequencyKind: 'daily', syncStatus: 'synced', createdAt: T0 } as any);
    holder.client = fakeClient({
      habits: [{ id: HABIT, user_id: USER, title: 'Read', type: 'binary', frequency_kind: 'daily', created_at: T0, updated_at: T0, deleted_at: T0 }],
      habit_completions: [],
    });
    await hydrateHabitsFromCloud(USER);
    expect(await db.habits.toArray()).toEqual([]);
  });

  it('a day cleared elsewhere leaves this device, under either id', async () => {
    const [server, mine] = [crypto.randomUUID(), crypto.randomUUID()];
    await db.habitCompletions.bulkPut([localCompletion(server), localCompletion(mine, 1, DAY, 'synced', crypto.randomUUID())] as any);
    // `mine` is the same day for the same habit, held under this device's id.
    await db.habitCompletions.put(localCompletion(mine) as any);
    holder.client = fakeClient({ habits: [], habit_completions: [{ ...serverCompletion(server), deleted_at: T0 }] });
    await hydrateHabitsFromCloud(USER);
    expect(await db.habitCompletions.toArray()).toEqual([]);
  });

  it('keeps a day re-marked here that has not been pushed yet', async () => {
    const [server, mine] = [crypto.randomUUID(), crypto.randomUUID()];
    await db.habitCompletions.put(localCompletion(mine, 2, DAY, 'pending') as any);
    await queue('insert', mine, localCompletion(mine, 2));
    holder.client = fakeClient({ habits: [], habit_completions: [{ ...serverCompletion(server), deleted_at: T0 }] });
    await hydrateHabitsFromCloud(USER);
    expect((await db.habitCompletions.toArray()).map((c) => c.id)).toEqual([mine]);
  });
});
