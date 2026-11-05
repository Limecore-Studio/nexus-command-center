import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeClient } from '../test/fakePostgrest';

// v1.20 (NCC#92) — work logs and braindump entries are deleted with a
// tombstone, so the user's other devices drop them too; a re-rated work day
// comes back; before the migration adds the column, the hard delete of old.
// Habits and their completions are in cloudSync.habits.test.ts.

const holder = vi.hoisted(() => ({ client: null as any }));
vi.mock('./supabase', () => ({
  get supabase() {
    return holder.client;
  },
}));
vi.mock('@capacitor/preferences', () => ({ Preferences: { get: async () => ({ value: null }), set: async () => {}, remove: async () => {} } }));

const { pushQueue, hydrateWorkQualityFromCloud, hydrateBraindumpFromCloud } = await import('./cloudSync');
const { db } = await import('../db/database');

const USER = 'user-1';
const DAY = '2026-10-20';
const T0 = '2026-10-20T08:00:00Z';
const uniques = { work_quality_logs: [['user_id', 'log_date']] };

async function queue(entityType: 'work_quality_log' | 'braindump_entry', operation: 'insert' | 'delete', entityId: string, payload: object) {
  await db.syncQueue.add({ id: crypto.randomUUID(), entityType, entityId, operation, payload: JSON.stringify(payload), createdAt: T0 });
}
const workLog = (id: string, over: object = {}) =>
  ({ id, user_id: USER, log_date: DAY, rating: 3, note: null, created_at: T0, updated_at: T0, ...over });

beforeEach(async () => {
  holder.client = null;
  await Promise.all(db.tables.map((t) => t.clear()));
});

describe('work logs', () => {
  it('a delete is a tombstone', async () => {
    const id = crypto.randomUUID();
    holder.client = fakeClient({ work_quality_logs: [workLog(id)] }, { uniques });
    await queue('work_quality_log', 'delete', id, { id });
    await pushQueue(USER);
    expect(holder.client.tables.work_quality_logs[0]).toMatchObject({ id, deleted_at: expect.any(String) });
  });

  it('...or the hard delete before the migration adds the column', async () => {
    const id = crypto.randomUUID();
    holder.client = fakeClient({ work_quality_logs: [workLog(id)] },
      { uniques, unknownColumns: { work_quality_logs: ['deleted_at'] } });
    await queue('work_quality_log', 'delete', id, { id });
    await pushQueue(USER);
    expect(holder.client.tables.work_quality_logs).toEqual([]);
  });

  it('re-rating a cleared day brings it back, on the server\'s row', async () => {
    const [server, mine] = [crypto.randomUUID(), crypto.randomUUID()];
    holder.client = fakeClient({ work_quality_logs: [workLog(server, { deleted_at: T0 })] }, { uniques });
    await queue('work_quality_log', 'insert', mine, { id: mine, date: DAY, rating: 5, note: null, createdAt: T0 });
    expect((await pushQueue(USER)).errors).toEqual([]);
    expect(holder.client.tables.work_quality_logs).toHaveLength(1);
    expect(holder.client.tables.work_quality_logs[0]).toMatchObject({ id: server, rating: 5, deleted_at: null });
  });

  it('a day cleared elsewhere leaves this device, unless re-rated here and unsent', async () => {
    const [server, synced, pending] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    await db.workQualityLogs.bulkPut([
      { id: server, date: DAY, rating: 3, note: null, syncStatus: 'synced', createdAt: T0 },
      { id: synced, date: DAY, rating: 3, note: null, syncStatus: 'synced', createdAt: T0 },
    ] as any);
    holder.client = fakeClient({ work_quality_logs: [workLog(server, { deleted_at: T0 })] });
    await hydrateWorkQualityFromCloud(USER);
    expect(await db.workQualityLogs.toArray()).toEqual([]);

    await db.workQualityLogs.put({ id: pending, date: DAY, rating: 4, note: null, syncStatus: 'pending', createdAt: T0 } as any);
    await queue('work_quality_log', 'insert', pending, { id: pending, date: DAY, rating: 4 });
    await hydrateWorkQualityFromCloud(USER);
    expect((await db.workQualityLogs.toArray()).map((l) => l.id)).toEqual([pending]);
  });
});

describe('braindump', () => {
  it('a delete is a tombstone', async () => {
    const id = crypto.randomUUID();
    holder.client = fakeClient({ braindump_entries: [{ id, user_id: USER, content: 'idea', created_at: T0, updated_at: T0, deleted_at: null }] });
    await queue('braindump_entry', 'delete', id, { id });
    await pushQueue(USER);
    expect(holder.client.tables.braindump_entries[0]).toMatchObject({ id, deleted_at: expect.any(String) });
  });

  it('an entry deleted elsewhere leaves this device; live ones stay', async () => {
    const [dead, live] = [crypto.randomUUID(), crypto.randomUUID()];
    await db.braindumpEntries.bulkPut([
      { id: dead, content: 'a', convertedTaskId: null, syncStatus: 'synced', createdAt: T0, updatedAt: T0, deletedAt: null },
      { id: live, content: 'b', convertedTaskId: null, syncStatus: 'synced', createdAt: T0, updatedAt: T0, deletedAt: null },
    ] as any);
    holder.client = fakeClient({ braindump_entries: [
      { id: dead, user_id: USER, content: 'a', created_at: T0, updated_at: T0, deleted_at: T0 },
      { id: live, user_id: USER, content: 'b', created_at: T0, updated_at: T0, deleted_at: null },
    ] });
    await hydrateBraindumpFromCloud(USER);
    expect((await db.braindumpEntries.toArray()).map((e) => e.id)).toEqual([live]);
  });
});
