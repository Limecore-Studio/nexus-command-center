import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeClient } from '../test/fakePostgrest';

// v1.18.1 (NCC#193) — a task's due time used to vanish on the first pull: the
// push sent the instant into a `date` column and the pull wrote the bare day
// back, which the edit form then showed as 03:00 (UTC midnight in Helsinki).

const holder = vi.hoisted(() => ({ client: null as any }));
vi.mock('./supabase', () => ({
  get supabase() {
    return holder.client;
  },
}));

const { pushQueue, pullAll } = await import('./cloudSync');
const { db } = await import('../db/database');
const { enqueue } = await import('../db/syncQueue');

const USER = 'user-1';
const T0 = '2026-09-01T00:00:00Z';
let tables: Record<string, any[]>;

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
  tables = {};
  const base = fakeClient(tables);
  holder.client = {
    from(table: string) {
      const b: any = base.from(table);
      b.upsert = (row: any) => {
        const arr = (tables[table] ??= []);
        const i = arr.findIndex((r) => r.id === row.id);
        const full = { created_at: T0, deleted_at: null, user_id: USER, ...row };
        if (i >= 0) arr[i] = { ...arr[i], ...full };
        else arr.push(full);
        return Promise.resolve({ error: null });
      };
      return b;
    },
  };
});

describe('task due time survives sync (NCC#193)', () => {
  it('push sends the local day and the instant; the pull brings the instant back', async () => {
    const id = crypto.randomUUID();
    const due = new Date(2026, 9, 20, 1, 30).toISOString(); // 01:30 local
    const task = { id, title: 'Essay', priority: 'medium', completed: false, dueDate: due, syncStatus: 'pending', createdAt: T0, updatedAt: T0 };
    await db.tasks.put(task as any);
    await enqueue('task', id, 'update', task);

    expect((await pushQueue(USER)).failed).toBe(0);
    expect(tables.tasks[0].due_date).toBe('2026-10-20');
    expect(tables.tasks[0].due_at).toBe(due);

    await pullAll(USER);
    expect((await db.tasks.get(id))?.dueDate).toBe(due);
  });

  it('a row from an older client (due_date only) arrives as a bare day', async () => {
    const id = crypto.randomUUID();
    tables.tasks = [{ id, user_id: USER, title: 'Old', priority: 'normal', status: 'todo', due_date: '2026-10-21', created_at: T0, updated_at: T0, deleted_at: null }];
    await pullAll(USER);
    expect((await db.tasks.get(id))?.dueDate).toBe('2026-10-21');
  });
});
