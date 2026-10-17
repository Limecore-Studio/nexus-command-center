import { describe, it, expect, beforeEach, vi } from 'vitest';

// v1.18.1 (limecore#59 §2, NCC#140) — every queued edit records whose it is,
// and only its owner pushes it. A guest's edits went up under whoever signed
// in next, before the "Existing data found" choice (Discard could not take
// them back); a session that ended without a sign-out left its queue to
// drain under the next account; and sign-out deleted the user's own offline
// edits to stop that. Real Dexie (fake-indexeddb), stand-in Supabase.

vi.mock('./supabase', () => ({
  supabase: { auth: { signOut: async () => ({ error: null }) }, from: () => ({}) },
  readStoredSession: async () => null,
  clearStoredSession: async () => {},
}));
vi.mock('./ssoPublisher', () => ({ publishSession: async () => {}, clearPublishedSession: async () => {} }));
vi.mock('./originMarker', () => ({ scheduleOriginStamp: () => {} }));
vi.mock('./guestMode', () => ({ setGuestMode: async () => {}, isGuestModeKnown: () => false }));
vi.stubGlobal('window', { dispatchEvent: () => true, addEventListener: () => {}, removeEventListener: () => {} });

const { db } = await import('../db/database');
const { enqueue, setQueueOwner, pushableFor, listOwnPending, hasGuestEdits } = await import('../db/syncQueue');
const { pushQueue, adoptLocalData } = await import('./cloudSync');
const { useSessionStore } = await import('../store/useSessionStore');

type Item = Parameters<typeof db.syncQueue.add>[0];
const item = (id: string, owner?: string | null): Item => ({
  id, entityType: 'bogus' as Item['entityType'], entityId: id, operation: 'insert', payload: '{}',
  createdAt: '2026-10-15T00:00:00Z', ...(owner !== undefined ? { owner } : {}),
});

beforeEach(async () => {
  await db.syncQueue.clear();
});

describe('queued edits record their owner', () => {
  // First in the file: the module's owner is still unset.
  it('records no owner before the session is known; the first known session claims those (NCC#172)', async () => {
    await enqueue('task', 't0', 'insert', {});
    useSessionStore.setState({ user: { id: 'u9' } as never, initialized: false });
    await enqueue('task', 't00', 'insert', {});
    expect((await db.syncQueue.toArray()).every((q) => !('owner' in q))).toBe(true);
    useSessionStore.setState({ initialized: true });
    await enqueue('task', 't000', 'insert', {});
    // NCC#172: the first known session also claims what was queued without an owner.
    await vi.waitFor(async () => {
      const owners = Object.fromEntries((await db.syncQueue.toArray()).map((q) => [q.entityId, q.owner]));
      expect(owners).toEqual({ t0: 'u9', t00: 'u9', t000: 'u9' });
    });
    useSessionStore.setState({ user: null, initialized: false });
  });

  it('the signed-in user, null as a guest, nothing before the session is known', async () => {
    setQueueOwner('u1');
    await enqueue('task', 't1', 'insert', {});
    setQueueOwner(null);
    await enqueue('task', 't2', 'insert', {});
    const byEntity = Object.fromEntries((await db.syncQueue.toArray()).map((q) => [q.entityId, q.owner]));
    expect(byEntity).toEqual({ t1: 'u1', t2: null });
  });

  it('pushableFor: own items and older ones, never a guest\'s or another account\'s', () => {
    expect(pushableFor({ owner: 'u1' }, 'u1')).toBe(true);
    expect(pushableFor({}, 'u1')).toBe(true);
    expect(pushableFor({ owner: null }, 'u1')).toBe(false);
    expect(pushableFor({ owner: 'u2' }, 'u1')).toBe(false);
  });
});

describe('the pending count', () => {
  it('counts only what the current owner would push; a guest\'s edits are flagged', async () => {
    await db.syncQueue.bulkAdd([item('own', 'u1'), item('older'), item('guest', null), item('other', 'u2')]);
    setQueueOwner('u1');
    expect((await listOwnPending()).map((q) => q.id).sort()).toEqual(['older', 'own']);
    setQueueOwner(null);
    expect((await listOwnPending()).map((q) => q.id).sort()).toEqual(['guest', 'older']);
    expect(await hasGuestEdits()).toBe(true);
    await adoptLocalData('u1');
    expect(await hasGuestEdits()).toBe(false);
  });
});

describe('pushQueue', () => {
  it('attempts only what the signed-in user may push', async () => {
    await db.syncQueue.bulkAdd([item('own', 'u1'), item('older'), item('guest', null), item('other', 'u2')]);
    const result = await pushQueue('u1');
    expect(result.attempted).toBe(2);
  });
});

describe('"Keep" on the Existing data prompt', () => {
  it('releases the guest\'s queued edits to the user who kept them', async () => {
    await db.syncQueue.bulkAdd([item('guest', null), item('other', 'u2')]);
    await adoptLocalData('u1');
    const owners = Object.fromEntries((await db.syncQueue.toArray()).map((q) => [q.id, q.owner]));
    expect(owners).toEqual({ guest: 'u1', other: 'u2' });
  });
});

describe('sign-out (NCC#140)', () => {
  it('keeps this user\'s unsynced edits and drops the ones that could reach another account', async () => {
    useSessionStore.setState({ user: { id: 'u1' } as never, initialized: true });
    await db.syncQueue.bulkAdd([item('own', 'u1'), item('older'), item('guest', null), item('done-older')]);
    await db.syncQueue.update('done-older', { syncedAt: '2026-10-15T01:00:00Z' });
    await useSessionStore.getState().signOut();
    expect((await db.syncQueue.toArray()).map((q) => q.id).sort()).toEqual(['done-older', 'own']);
  });
});
