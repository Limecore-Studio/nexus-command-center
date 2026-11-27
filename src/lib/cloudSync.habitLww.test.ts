import { describe, it, expect, beforeEach, vi } from 'vitest';

// v1.22 (limecore#113) — the habits trigger stamps now() on every write, so
// an offline edit pushed late used to beat a newer one. NCC now skips an edit
// older than the server's row; the pull brings the newer one.

const h = vi.hoisted(() => ({ serverStamp: null as string | null, upserts: 0 }));
vi.mock('./supabase', () => ({
  supabase: {
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: h.serverStamp ? { updated_at: h.serverStamp } : null, error: null }) }) }),
      upsert: async () => {
        h.upserts++;
        return { error: null };
      },
    }),
  },
}));

const { pushQueue } = await import('./cloudSync');
const { enqueue, listPending } = await import('../db/syncQueue');
const { db } = await import('../db/database');

const habit = (updatedAt: string) => ({
  id: crypto.randomUUID(), title: 'Run', type: 'boolean', frequencyKind: 'daily', createdAt: '2026-11-01T00:00:00Z', updatedAt,
});

beforeEach(async () => {
  h.serverStamp = null;
  h.upserts = 0;
  await Promise.all(db.tables.map((t) => t.clear()));
});

describe('habit push and a newer server row', () => {
  it('does not send an edit older than the server row', async () => {
    const hb = habit('2026-11-20T10:00:00Z');
    h.serverStamp = '2026-11-20T12:00:00Z';
    await enqueue('habit', hb.id, 'update', hb);
    await pushQueue('u1');
    expect(h.upserts).toBe(0);
    expect(await listPending()).toHaveLength(0);
  });

  it('sends an edit newer than the server row, or a new habit', async () => {
    const newer = habit('2026-11-20T14:00:00Z');
    h.serverStamp = '2026-11-20T12:00:00Z';
    await enqueue('habit', newer.id, 'update', newer);
    await pushQueue('u1');
    expect(h.upserts).toBe(1);

    h.serverStamp = null;
    const fresh = habit('2026-11-21T09:00:00Z');
    await enqueue('habit', fresh.id, 'insert', fresh);
    await pushQueue('u1');
    expect(h.upserts).toBe(2);
  });
});
