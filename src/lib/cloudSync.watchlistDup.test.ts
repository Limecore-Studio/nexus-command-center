import { describe, it, expect, beforeEach, vi } from 'vitest';

// v1.22 (NCC#263) — the same ticker added on two devices: the second insert
// hits the live-row unique index (23505). The edit goes onto the server's row
// and the local duplicate takes that row's id, instead of being dropped.

const h = vi.hoisted(() => ({ updates: [] as any[], serverId: 'server-row-id' }));
vi.mock('./supabase', () => ({
  supabase: {
    from: () => ({
      upsert: async () => ({ error: { code: '23505', message: 'duplicate key value violates unique constraint "watchlist_items_live_uidx"' } }),
      update: (patch: any) => {
        const filters: Record<string, unknown> = {};
        const chain: any = {
          eq: (c: string, v: unknown) => ((filters[c] = v), chain),
          is: (c: string, v: unknown) => ((filters[c] = v), chain),
          select: async () => {
            h.updates.push({ patch, filters });
            return { data: [{ id: h.serverId }], error: null };
          },
        };
        return chain;
      },
    }),
  },
}));

const { pushQueue } = await import('./cloudSync');
const { enqueue, listPending } = await import('../db/syncQueue');
const { db } = await import('../db/database');

beforeEach(async () => {
  h.updates = [];
  await Promise.all(db.tables.map((t) => t.clear()));
});

describe('watchlist duplicate across devices', () => {
  it('writes the edit onto the server row and re-keys the local one', async () => {
    const localId = crypto.randomUUID();
    const item = { id: localId, ticker: 'AAPL', name: 'Apple', assetType: 'stock', targetAbove: 250, createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z' };
    await db.watchlistItems.put(item as any);
    await enqueue('watchlist_item', localId, 'insert', item);

    const r = await pushQueue('u1');
    expect(r.errors).toEqual([]);
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0].filters).toMatchObject({ user_id: 'u1', ticker: 'AAPL', asset_type: 'stock', deleted_at: null });
    expect(h.updates[0].patch.target_above).toBe(250);
    expect(await db.watchlistItems.get(localId)).toBeUndefined();
    expect((await db.watchlistItems.get('server-row-id'))?.ticker).toBe('AAPL');
    expect(await listPending()).toHaveLength(0);
  });
});
