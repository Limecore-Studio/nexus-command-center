import { describe, it, expect, beforeEach, vi } from 'vitest';

// v1.21.1 (limecore#102) — deleting an account never pretends. "Guest or
// account" comes from the device (a stored session, the last signed-in user),
// so a session that cannot be refreshed no longer reads as a guest.

const h = vi.hoisted(() => ({
  session: null as null | { user: { id: string } },
  sessionError: null as null | { message: string },
  stored: null as null | object,
  invokeError: null as null | { message: string },
  invoked: 0,
  signOuts: [] as unknown[],
}));

vi.mock('./supabase', () => ({
  readStoredSession: async () => h.stored,
  get supabase() {
    return {
      auth: {
        getSession: async () => ({ data: { session: h.session }, error: h.sessionError }),
        signOut: async (opts: unknown) => {
          h.signOuts.push(opts);
          return { error: null };
        },
      },
      functions: {
        invoke: async () => {
          h.invoked++;
          return { error: h.invokeError };
        },
      },
    };
  },
}));

// limecore#103/#114: capture what would be written instead of a picker.
const saved = vi.hoisted(() => ({ files: [] as { name: string; data: string }[], cancel: false }));
vi.mock('./saveFile', () => ({
  saveTextFile: async (name: string, data: string) => {
    if (saved.cancel) return false;
    saved.files.push({ name, data });
    return true;
  },
}));

// Native Preferences, holding what a signed-in device with a PIN holds.
const JWT = 'eyJhbGciOiJFUzI1NiIsImtpZCI6ImFiYyJ9.eyJzdWIiOiJ1c2VyLTEiLCJzZXNzaW9uX2lkIjoicyJ9.c2lnbmF0dXJlLWJ5dGVzLWhlcmU';
const prefs = vi.hoisted(() => new Map<string, string>());
vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    keys: async () => ({ keys: [...prefs.keys()] }),
    get: async ({ key }: { key: string }) => ({ value: prefs.get(key) ?? null }),
  },
}));

const { deleteAccount, downloadExport, exportableSetting } = await import('./dataRights');
const { LAST_USER_KEY } = await import('./adoptionChoice');

let wiped = 0;
const clearLocal = async () => {
  wiped++;
};

beforeEach(() => {
  localStorage.clear();
  Object.assign(h, { session: null, sessionError: null, stored: null, invokeError: null, invoked: 0, signOuts: [] });
  wiped = 0;
});

describe('deleteAccount', () => {
  it('refuses and wipes nothing when an account is recorded but the session is gone', async () => {
    localStorage.setItem(LAST_USER_KEY, 'user-1');
    expect(await deleteAccount({ clearLocal })).toEqual({ deleted: 'nothing', reason: 'signed-out' });
    expect(wiped).toBe(0);
    expect(h.invoked).toBe(0);
  });

  it('refuses when a session is stored but cannot be refreshed', async () => {
    h.stored = { user: { id: 'user-1' }, refresh_token: 'r' };
    h.sessionError = { message: 'Invalid Refresh Token' };
    expect((await deleteAccount({ clearLocal })).deleted).toBe('nothing');
    expect(wiped).toBe(0);
    expect(h.invoked).toBe(0);
  });

  it('refuses on a getSession error even with nothing recorded', async () => {
    h.sessionError = { message: 'Failed to fetch' };
    expect((await deleteAccount({ clearLocal })).deleted).toBe('nothing');
    expect(wiped).toBe(0);
  });

  it('wipes the device for a real guest and says there was no account', async () => {
    expect(await deleteAccount({ clearLocal })).toEqual({ deleted: 'local' });
    expect(wiped).toBe(1);
    expect(h.invoked).toBe(0);
  });

  it('treats the guest marker as a guest', async () => {
    localStorage.setItem(LAST_USER_KEY, 'guest');
    expect((await deleteAccount({ clearLocal })).deleted).toBe('local');
    expect(wiped).toBe(1);
  });

  it('deletes the account, then removes the stored session locally and wipes', async () => {
    h.session = { user: { id: 'user-1' } };
    expect(await deleteAccount({ clearLocal })).toEqual({ deleted: 'account' });
    expect(h.invoked).toBe(1);
    expect(h.signOuts).toEqual([{ scope: 'local' }]);
    expect(wiped).toBe(1);
  });

  it('wipes nothing when the server refuses', async () => {
    h.session = { user: { id: 'user-1' } };
    h.invokeError = { message: 'boom' };
    await expect(deleteAccount({ clearLocal })).rejects.toThrow('boom');
    expect(wiped).toBe(0);
    expect(h.signOuts).toEqual([]);
  });
});

describe('export file (limecore#103, #114)', () => {
  beforeEach(() => {
    saved.files = [];
    saved.cancel = false;
    prefs.clear();
    const session = JSON.stringify({ access_token: JWT, refresh_token: 'r3fr3sh', user: { id: 'user-1' } });
    prefs.set('nexus-supabase-session', session);
    prefs.set('suite.sso.session', session);
    prefs.set('suite.sso.session.publishedAt', '1763290000000');
    prefs.set('auth.pin', 'v3:aXY=:Y2lwaGVy');
    prefs.set('auth.pinFailedAttempts', '2');
    prefs.set('auth.pinLastFailAt', '1763290000000');
    prefs.set('apikey_finnhub', 'abcdef0123456789abcdef0123456789abcdef01');
    prefs.set('settings.baseCurrency', 'EUR');
    prefs.set('auth.autoLockMin', '5');
    // An allowed key holding a token-shaped value is dropped too.
    prefs.set('settings.someToken', JWT);
    localStorage.setItem('nexus.theme', 'dark');
    localStorage.setItem('sb-hkktorzhaqnfqsnlstda-auth-token', JSON.stringify({ access_token: JWT }));
  });

  const exported = async () => {
    expect(await downloadExport(null)).toMatch(/^nexus-export-\d{4}-\d{2}-\d{2}\.json$/);
    return saved.files[0];
  };

  it('keeps known preferences and nothing that looks like a token, session or PIN', async () => {
    const file = await exported();
    const payload = JSON.parse(file.data);
    expect(payload.settings).toEqual({ 'settings.baseCurrency': 'EUR', 'auth.autoLockMin': '5', 'nexus.theme': 'dark' });
    for (const [k, v] of Object.entries(payload.settings as Record<string, string>)) {
      expect(k).not.toMatch(/session|token|sso|pin|apikey|auth-token/i);
      expect(v).not.toMatch(/eyJ|token|r3fr3sh|v3:/);
    }
    // And nowhere in the file at all.
    expect(file.data).not.toMatch(/eyJ[\w-]+\.|access_token|refresh_token|r3fr3sh|auth\.pin|suite\.sso/);
  });

  it('leaves the sync queue out', async () => {
    const payload = JSON.parse((await exported()).data);
    expect(payload.data).not.toHaveProperty('syncQueue');
    expect(payload.excluded).toHaveProperty('syncQueue');
  });

  it('returns null when the picker is cancelled', async () => {
    saved.cancel = true;
    expect(await downloadExport(null)).toBeNull();
  });

  it('allowlist refuses credential keys outright', () => {
    for (const k of ['auth.pin', 'auth.pinFailedAttempts', 'nexus-supabase-session', 'suite.sso.session', 'apikey_finnhub']) {
      expect(exportableSetting(k, 'x')).toBe(false);
    }
  });
});
