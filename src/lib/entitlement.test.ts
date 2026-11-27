import { describe, it, expect, beforeEach, vi } from 'vitest';

// v1.22 (NCC#263) — the supporter answer belongs to one account, and a "no"
// is not cached for hours.

const row = vi.hoisted(() => ({ data: null as unknown, error: null as unknown, calls: 0 }));
vi.mock('./supabase', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => {
            row.calls++;
            return { data: row.data, error: row.error };
          },
        }),
      }),
    }),
  },
}));

// The test setup provides localStorage.
const store = {
  clear: () => localStorage.removeItem('nexus.entitlement'),
  get: (k: string) => localStorage.getItem(k),
  set: (k: string, v: string) => localStorage.setItem(k, v),
};

const { refreshEntitlement, isEntitled } = await import('./entitlement');

const future = new Date(Date.now() + 30 * 864e5).toISOString();

describe('refreshEntitlement', () => {
  beforeEach(() => {
    store.clear();
    row.data = null;
    row.error = null;
    row.calls = 0;
  });

  it("never serves another account's record, even when offline", async () => {
    row.data = { tier: 'member', expires_at: future, lifetime: false };
    expect(await refreshEntitlement('a')).toBe(true);
    row.error = { message: 'Failed to fetch' };
    expect(await refreshEntitlement('b')).toBe(false);
    expect(isEntitled()).toBe(false);
  });

  it('asks again after 5 minutes when the answer was no', async () => {
    expect(await refreshEntitlement('a')).toBe(false);
    expect(row.calls).toBe(1);
    await refreshEntitlement('a');
    expect(row.calls).toBe(1); // inside the short window: cached
    const rec = JSON.parse(store.get('nexus.entitlement')!);
    rec.checkedAt -= 6 * 60 * 1000;
    store.set('nexus.entitlement', JSON.stringify(rec));
    row.data = { tier: 'member', expires_at: future, lifetime: false };
    expect(await refreshEntitlement('a')).toBe(true);
    expect(row.calls).toBe(2);
  });

  it("keeps a supporter's answer for hours", async () => {
    row.data = { tier: 'member', expires_at: future, lifetime: false };
    await refreshEntitlement('a');
    const rec = JSON.parse(store.get('nexus.entitlement')!);
    rec.checkedAt -= 60 * 60 * 1000;
    store.set('nexus.entitlement', JSON.stringify(rec));
    await refreshEntitlement('a');
    expect(row.calls).toBe(1);
  });
});
