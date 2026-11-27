import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeClient } from '../test/fakePostgrest';

// v1.22 (limecore#99) — while sharing is off, the pull takes only this
// account's own tasks and budget categories, and drops another account's rows
// that an earlier pull brought in.

const holder = vi.hoisted(() => ({ client: null as any }));
vi.mock('./supabase', () => ({
  get supabase() {
    return holder.client;
  },
}));

const { pullAll } = await import('./cloudSync');
const { db } = await import('../db/database');

const ME = 'user-1';
const OTHER = 'user-2';
const T0 = '2026-11-01T00:00:00Z';

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
});

describe('pull while sharing is off', () => {
  it('filters tasks and budget categories to this account and drops foreign rows', async () => {
    const mine = crypto.randomUUID();
    const theirs = crypto.randomUUID();
    holder.client = fakeClient({
      tasks: [
        { id: mine, user_id: ME, title: 'Mine', status: 'todo', priority: 'medium', created_at: T0, updated_at: T0 },
        { id: theirs, user_id: OTHER, title: 'Shared in', status: 'todo', priority: 'medium', created_at: T0, updated_at: T0 },
      ],
      budget_categories: [],
    });
    await db.tasks.put({ id: theirs, title: 'Shared in', priority: 'medium', completed: false, syncStatus: 'synced', createdAt: T0, ownerId: OTHER } as any);

    await pullAll(ME, new Set(['tasks', 'budget_categories']));

    const req = holder.client.requests.filter((r: any) => r.table === 'tasks' || r.table === 'budget_categories');
    expect(req.length).toBeGreaterThan(0);
    for (const r of req) expect(r.filters).toContainEqual(['eq', 'user_id', ME]);
    expect(await db.tasks.get(mine)).toBeTruthy();
    expect(await db.tasks.get(theirs)).toBeUndefined();
  });
});
