import { describe, it, expect, beforeEach, vi } from 'vitest';

// v1.18.1 — limecore#58. App-lock behaviour: a stored PIN the device can't
// decrypt is kept and the app stays locked; activity after the auto-lock
// limit locks rather than restarting the idle clock.

const prefs = vi.hoisted(() => new Map<string, string>());
const ks = vi.hoisted(() => ({ fail: false, garble: false }));

vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: async ({ key }: { key: string }) => ({ value: prefs.has(key) ? prefs.get(key)! : null }),
    set: async ({ key, value }: { key: string; value: string }) => void prefs.set(key, value),
    remove: async ({ key }: { key: string }) => void prefs.delete(key),
  },
}));

// A Keystore stand-in, with switches to make decrypt throw the way a
// Keystore error does, or return the wrong value.
vi.mock('@/lib/keystore', () => ({
  KEYSTORE_ALIAS_PIN: 'auth.pin',
  keystoreAvailable: () => true,
  ensureKey: async () => true,
  encrypt: async (_alias: string, plaintext: string) => ({ ciphertext: btoa(plaintext), iv: 'iv' }),
  decrypt: async (_alias: string, ciphertext: string) => {
    if (ks.fail) throw new Error('KeyStoreException');
    return ks.garble ? 'garbled' : atob(ciphertext);
  },
}));

const { useAuthStore } = await import('./useAuthStore');

beforeEach(() => {
  prefs.clear();
  ks.fail = false;
  ks.garble = false;
  useAuthStore.setState({ unlocked: false, hasPin: false, pinUnreadable: false, ready: false, failedAttempts: 0, lockedUntil: 0 });
});

describe('a v3 PIN that fails to decrypt (limecore#58 §1)', () => {
  it('is kept at startup, and the app stays locked with a PIN to enter', async () => {
    await useAuthStore.getState().setPin('123456');
    expect(prefs.get('auth.pin')!.startsWith('v3:')).toBe(true);

    ks.fail = true;
    await useAuthStore.getState().init();
    const s = useAuthStore.getState();
    expect(prefs.get('auth.pin')!.startsWith('v3:')).toBe(true);
    expect(s.hasPin).toBe(true);
    expect(s.pinUnreadable).toBe(true);
    expect(s.unlocked).toBe(false);
  });

  it('is not counted as a wrong guess, and the right PIN works once Keystore answers again', async () => {
    await useAuthStore.getState().setPin('123456');
    ks.fail = true;
    await useAuthStore.getState().init();

    const miss = await useAuthStore.getState().verifyPin('123456');
    expect(miss).toEqual({ ok: false, unreadable: true });
    expect(useAuthStore.getState().failedAttempts).toBe(0);

    ks.fail = false;
    expect((await useAuthStore.getState().verifyPin('000000')).ok).toBe(false);
    expect((await useAuthStore.getState().verifyPin('123456')).ok).toBe(true);
    expect(useAuthStore.getState().pinUnreadable).toBe(false);
  });
});

describe('storing a v3 PIN (limecore#58)', () => {
  it('keeps the v2 form when the wrapped value does not read back', async () => {
    ks.garble = true;
    await useAuthStore.getState().setPin('123456');
    expect(prefs.get('auth.pin')!.startsWith('v2:')).toBe(true);
    ks.garble = false;
    expect((await useAuthStore.getState().verifyPin('123456')).ok).toBe(true);
  });

  it('init() marks the store ready', async () => {
    expect(useAuthStore.getState().ready).toBe(false);
    await useAuthStore.getState().init();
    expect(useAuthStore.getState().ready).toBe(true);
  });
});

describe('auto-lock after the idle limit (limecore#58)', () => {
  it('a tap after the idle limit locks instead of resetting the clock', () => {
    useAuthStore.setState({ unlocked: true, autoLockMinutes: 5, lastActivity: Date.now() - 60 * 60_000 });
    useAuthStore.getState().bumpActivity();
    expect(useAuthStore.getState().unlocked).toBe(false);
  });

  it('a tap inside the limit keeps the app open and resets the clock', () => {
    const before = Date.now() - 60_000;
    useAuthStore.setState({ unlocked: true, autoLockMinutes: 5, lastActivity: before });
    useAuthStore.getState().bumpActivity();
    expect(useAuthStore.getState().unlocked).toBe(true);
    expect(useAuthStore.getState().lastActivity).toBeGreaterThan(before);
  });

  it('does nothing to the lock where the app was never unlocked (web, desktop)', () => {
    useAuthStore.setState({ unlocked: false, autoLockMinutes: 5, lastActivity: Date.now() - 60 * 60_000 });
    useAuthStore.getState().bumpActivity();
    expect(useAuthStore.getState().unlocked).toBe(false);
    expect(Date.now() - useAuthStore.getState().lastActivity).toBeLessThan(1000);
  });
});
