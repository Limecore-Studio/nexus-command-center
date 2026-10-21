import { describe, it, expect, vi } from 'vitest';
import { fakeClient } from '../test/fakePostgrest';

// v1.18.1 (NCC#154) — a work rating made for the same day on two devices.
// Each device makes its own id, the table has UNIQUE (user_id, log_date), and
// the second push hit 23505 and was dropped; that device kept two rows for the
// day and every later edit to its own row was dropped again.

const holder = vi.hoisted(() => ({ client: null as any }));
vi.mock('./supabase', () => ({
  get supabase() {
    return holder.client;
  },
}));
vi.mock('@capacitor/preferences', () => ({ Preferences: { get: async () => ({ value: null }), set: async () => {}, remove: async () => {} } }));

const { pushQueue, pullAll } = await import('./cloudSync');
const { db } = await import('../db/database');
const { useWorkQualityStore } = await import('../store/useWorkQualityStore');

describe('same-day work rating on two devices (NCC#154)', () => {
  it('lands on the server row for that day, and the device ends with one row', async () => {
    const USER = 'u1';
    const day = '2026-10-10';
    const serverId = crypto.randomUUID();
    // Device A already pushed its rating for the day.
    const tables: Record<string, any[]> = {
      work_quality_logs: [{ id: serverId, user_id: USER, log_date: day, rating: 2, note: null, created_at: 'x', updated_at: '2026-10-10T08:00:00Z' }],
    };
    holder.client = fakeClient(tables, { uniques: { work_quality_logs: [['user_id', 'log_date']] } });

    // Device B, not yet pulled, rates the same day.
    await useWorkQualityStore.getState().load();
    await useWorkQualityStore.getState().setRating(5, undefined, day);
    const r = await pushQueue(USER);
    expect(r.errors).toEqual([]);
    expect(tables.work_quality_logs).toHaveLength(1);
    expect(tables.work_quality_logs[0].rating).toBe(5);

    await pullAll(USER);
    const local = await db.workQualityLogs.where('date').equals(day).toArray();
    expect(local.map((l) => [l.id, l.rating])).toEqual([[serverId, 5]]);

    // A later edit on B goes to that row and lands.
    await useWorkQualityStore.getState().load();
    await useWorkQualityStore.getState().setRating(4, undefined, day);
    expect((await pushQueue(USER)).errors).toEqual([]);
    expect(tables.work_quality_logs.map((r) => r.rating)).toEqual([4]);
  });
});

describe('same-day update that finds no row (NCC#154 review)', () => {
  it('stays queued instead of reporting success, and lands on the next drain', async () => {
    const USER = 'u2';
    const day = '2026-10-11';
    const tables: Record<string, any[]> = {
      work_quality_logs: [{ id: crypto.randomUUID(), user_id: USER, log_date: day, rating: 2, note: null, created_at: 'x', updated_at: 'x' }],
    };
    const base = fakeClient(tables, { uniques: { work_quality_logs: [['user_id', 'log_date']] } });
    // The other device's row disappears between the upsert and the update.
    holder.client = {
      from(table: string) {
        const b: any = base.from(table);
        const upsert = b.upsert;
        b.upsert = (row: any) => {
          const res = upsert(row);
          return { then: (ok: any, bad: any) => Promise.resolve(res).then((r: any) => { tables.work_quality_logs = tables.work_quality_logs.filter((x) => x.id === row.id); return r; }).then(ok, bad) };
        };
        return b;
      },
    };
    await db.syncQueue.clear();
    await useWorkQualityStore.getState().load();
    await useWorkQualityStore.getState().setRating(3, undefined, day);
    const r1 = await pushQueue(USER);
    expect(r1.errors).toHaveLength(1);
    expect(r1.errors[0].message).not.toContain('[dropped');

    holder.client = base;
    const r2 = await pushQueue(USER);
    expect(r2.errors).toEqual([]);
    expect(tables.work_quality_logs.some((r) => r.log_date === day && r.rating === 3)).toBe(true);
  });
});

describe('hydrate leaves a row with a pending change alone (NCC#161)', () => {
  it('does not revert an unsent rating to the server copy', async () => {
    const USER = 'u3';
    const day = '2026-10-12';
    const id = crypto.randomUUID();
    const tables: Record<string, any[]> = {
      work_quality_logs: [{ id, user_id: USER, log_date: day, rating: 2, note: null, created_at: 'x', updated_at: '2026-10-12T08:00:00Z' }],
    };
    holder.client = fakeClient(tables);
    await db.syncQueue.clear();
    await db.workQualityLogs.clear();
    const edited = { id, date: day, rating: 5, note: null, syncStatus: 'pending', createdAt: 'x', updatedAt: '2026-10-12T09:00:00Z' };
    await db.workQualityLogs.put(edited as any);
    await db.syncQueue.add({ id: crypto.randomUUID(), entityType: 'work_quality_log', entityId: id, operation: 'update', payload: JSON.stringify(edited), createdAt: 'x' } as any);

    await pullAll(USER);
    expect((await db.workQualityLogs.get(id))?.rating).toBe(5);
  });
});
