import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeClient } from '../test/fakePostgrest';

// v1.22 (NCC#261) — Force Re-sync used to queue every local course, budget and
// holding stamped "now", so this device's last-pulled copy overwrote newer
// edits made elsewhere (and re-created courses purged as deleted).

const holder = vi.hoisted(() => ({ client: null as any }));
vi.mock('./supabase', () => ({
  get supabase() {
    return holder.client;
  },
}));

const { resyncLocalData, adoptLocalData } = await import('./cloudSync');
const { db } = await import('../db/database');

const USER = 'user-1';
const ON_SERVER = '11111111-1111-4111-8111-111111111111';
const LOCAL_ONLY = '22222222-2222-4222-8222-222222222222';

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
  holder.client = fakeClient({
    budget_categories: [{ id: ON_SERVER, user_id: USER }],
    portfolio_holdings: [{ id: ON_SERVER, user_id: USER, deleted_at: '2026-10-01T00:00:00Z' }],
  });
  await db.budgetCategories.bulkPut([{ id: ON_SERVER, name: 'Food' }, { id: LOCAL_ONLY, name: 'New' }] as any);
  await db.portfolioHoldings.bulkPut([{ id: ON_SERVER, ticker: 'OLD' }, { id: LOCAL_ONLY, ticker: 'NEW' }] as any);
  await db.courses.bulkPut([{ id: ON_SERVER, name: 'Maths' }, { id: LOCAL_ONLY, name: 'Gone?' }] as any);
});

const queued = async () => (await db.syncQueue.toArray()).map((q) => `${q.entityType}:${q.entityId}`).sort();

describe('Force Re-sync (NCC#261)', () => {
  it('queues only rows the server has never had (tombstones count as had), and no courses', async () => {
    await resyncLocalData(USER);
    expect(await queued()).toEqual([`budget_category:${LOCAL_ONLY}`, `portfolio_holding:${LOCAL_ONLY}`]);
  });

  it('queues nothing when the ids cannot be read', async () => {
    holder.client = fakeClient({}, { failWhen: () => ({ code: "57014", message: "timeout" }) });
    await expect(resyncLocalData(USER)).rejects.toThrow();
    expect(await queued()).toEqual([]);
  });

  it('the account-switch "Keep" adoption is unchanged', async () => {
    await adoptLocalData(USER);
    expect((await queued()).length).toBe(6);
  });
});
