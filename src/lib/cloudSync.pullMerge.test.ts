import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeClient } from '../test/fakePostgrest';

// v1.18.1 (NCC#146) — the pull wrote a freshly mapped row over the local one.
// Fields with no server column (task category, transaction notes, a budget
// category's default account) vanished on every sync, even on one device,
// and a pull landing while an edit was still queued reverted that edit.

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
  // A server that stores whatever the push sends.
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

describe('pull keeps what the server does not hold (NCC#146)', () => {
  it('task category, transaction notes and a category default account survive push + pull', async () => {
    const taskId = crypto.randomUUID();
    const txId = crypto.randomUUID();
    const catId = crypto.randomUUID();
    const acctId = crypto.randomUUID();
    const task = { id: taskId, title: 'Essay', priority: 'medium', category: 'study', completed: false, syncStatus: 'pending', createdAt: T0, updatedAt: T0 };
    const tx = { id: txId, amount: 12, description: 'Lunch', notes: 'with Anna, split later', categoryId: catId, accountId: acctId, date: '2026-09-02', type: 'expense', syncStatus: 'pending', createdAt: T0 };
    const cat = { id: catId, name: 'Food', monthlyLimit: 300, icon: 'food', linkedManualAssetId: acctId, createdAt: T0 };
    await db.tasks.put(task as any);
    await db.transactions.put(tx as any);
    await db.budgetCategories.put(cat as any);
    await enqueue('task', taskId, 'update', task);
    await enqueue('transaction', txId, 'update', tx);
    await enqueue('budget_category', catId, 'update', cat);

    expect((await pushQueue(USER)).failed).toBe(0);
    await pullAll(USER);

    expect((await db.tasks.get(taskId))?.category).toBe('study');
    expect((await db.transactions.get(txId))?.notes).toBe('with Anna, split later');
    expect((await db.budgetCategories.get(catId))?.linkedManualAssetId).toBe(acctId);
    // The server's own fields still arrive.
    expect((await db.tasks.get(taskId))?.syncStatus).toBe('synced');
  });

  it('a row with a change still queued is not overwritten by the server copy', async () => {
    const taskId = crypto.randomUUID();
    tables.tasks = [{ id: taskId, user_id: USER, title: 'Old title', priority: 'normal', status: 'todo', created_at: T0, updated_at: T0, deleted_at: null }];
    const edited = { id: taskId, title: 'New title', priority: 'medium', completed: false, syncStatus: 'pending', createdAt: T0, updatedAt: '2026-09-02T00:00:00Z' };
    await db.tasks.put(edited as any);
    await enqueue('task', taskId, 'update', edited);

    await pullAll(USER);
    expect((await db.tasks.get(taskId))?.title).toBe('New title');
  });
});
