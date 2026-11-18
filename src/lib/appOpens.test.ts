import { describe, it, expect, beforeEach, vi } from 'vitest';

// v1.21.1 (limecore#87) — no app-open row is queued without this account's yes.

const h = vi.hoisted(() => ({ session: null as null | { user: { id: string } }, queued: [] as unknown[] }));
vi.mock('./supabase', () => ({
  get supabase() {
    return { auth: { getSession: async () => ({ data: { session: h.session } }) } };
  },
}));
vi.mock('../db/syncQueue', () => ({
  enqueue: async (...args: unknown[]) => {
    h.queued.push(args);
  },
}));

const { recordAppOpen } = await import('./appOpens');
const { setConsent, pendingConsent } = await import('./usageConsent');

beforeEach(() => {
  localStorage.clear();
  h.session = { user: { id: 'user-1' } };
  h.queued = [];
});

describe('recordAppOpen', () => {
  it('queues nothing while the account has not been asked', async () => {
    expect(await recordAppOpen()).toBe(false);
    expect(h.queued).toEqual([]);
  });

  it('queues nothing after a no', async () => {
    setConsent('appOpens', false, 'user-1');
    expect(await recordAppOpen()).toBe(false);
    expect(h.queued).toEqual([]);
  });

  it('queues once a day after a yes', async () => {
    setConsent('appOpens', true, 'user-1');
    expect(await recordAppOpen()).toBe(true);
    expect(await recordAppOpen()).toBe(false);
    expect(h.queued).toHaveLength(1);
  });

  it("another account's yes does not cover this one", async () => {
    setConsent('appOpens', true, 'user-2');
    expect(await recordAppOpen()).toBe(false);
    expect(h.queued).toEqual([]);
  });
});

describe('pendingConsent', () => {
  it('asks a signed-in Android owner both, a guest only the update check', () => {
    expect(pendingConsent('user-1', 'android')).toEqual(['updateCheck', 'appOpens']);
    expect(pendingConsent('guest', 'android')).toEqual(['updateCheck']);
    expect(pendingConsent('user-1', 'web')).toEqual(['appOpens']);
    expect(pendingConsent('guest', 'web')).toEqual([]);
  });

  it('an answer, yes or no, is not asked again', () => {
    setConsent('updateCheck', false, 'user-1');
    setConsent('appOpens', true, 'user-1');
    expect(pendingConsent('user-1', 'android')).toEqual([]);
  });
});
