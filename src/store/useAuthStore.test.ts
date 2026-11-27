import { describe, it, expect, beforeEach, vi } from 'vitest';

// v1.18.1 — limecore#58. App-lock behaviour: a stored PIN the device can't
// decrypt is kept and the app stays locked; activity after the auto-lock
// limit locks rather than restarting the idle clock.

const prefs = vi.hoisted(() => new Map<string, string>());
const ks = vi.hoisted(() => ({ fail: false, garble: false, encryptFails: false }));

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
  encrypt: async (_alias: string, plaintext: string) => {
    // limecore#47: what the broken encrypt did before #240.
    if (ks.encryptFails) throw new Error('Caller-provided IV not permitted');
    return { ciphertext: btoa(plaintext), iv: 'iv' };
  },
  decrypt: async (_alias: string, ciphertext: string) => {
    if (ks.fail) throw new Error('KeyStoreException');
    return ks.garble ? 'garbled' : atob(ciphertext);
  },
}));

const { useAuthStore, whenLocked } = await import('./useAuthStore');
const { clearPin } = await import('../lib/clearPin');

beforeEach(() => {
  prefs.clear();
  ks.fail = false;
  ks.garble = false;
  ks.encryptFails = false;
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

// v1.21.1 — NCC#240 (limecore#47): while encrypt was broken every PIN stayed
// v2. Updating must upgrade it without locking anyone out.
describe('upgrading from the broken v3 wrapping (limecore#47)', () => {
  it('a PIN set while encrypt failed is v2, and still unlocks', async () => {
    ks.encryptFails = true;
    await useAuthStore.getState().setPin('123456');
    expect(prefs.get('auth.pin')!.startsWith('v2:')).toBe(true);
    expect((await useAuthStore.getState().verifyPin('123456')).ok).toBe(true);
  });

  it('after the fix, the next launch wraps it as v3 and the same PIN unlocks', async () => {
    ks.encryptFails = true;
    await useAuthStore.getState().setPin('123456');
    ks.encryptFails = false;
    await useAuthStore.getState().init();
    expect(prefs.get('auth.pin')!.startsWith('v3:')).toBe(true);
    expect(useAuthStore.getState().pinUnreadable).toBe(false);
    expect((await useAuthStore.getState().verifyPin('123456')).ok).toBe(true);
    expect((await useAuthStore.getState().verifyPin('654321')).ok).toBe(false);
  });

  it('a wrap that does not read back keeps v2, so the PIN still works', async () => {
    ks.encryptFails = true;
    await useAuthStore.getState().setPin('123456');
    ks.encryptFails = false;
    ks.garble = true;
    await useAuthStore.getState().init();
    expect(prefs.get('auth.pin')!.startsWith('v2:')).toBe(true);
    ks.garble = false;
    expect((await useAuthStore.getState().verifyPin('123456')).ok).toBe(true);
  });

  it('a launch where encrypt still fails changes nothing', async () => {
    ks.encryptFails = true;
    await useAuthStore.getState().setPin('123456');
    const before = prefs.get('auth.pin');
    await useAuthStore.getState().init();
    expect(prefs.get('auth.pin')).toBe(before);
    expect(useAuthStore.getState().hasPin).toBe(true);
  });
});

// v1.21.1 — NCC#259.
describe('removing the PIN (Clear All Data, Forgot PIN)', () => {
  it('clearPin removes the PIN and its counters, so the next launch asks for a new one', async () => {
    await useAuthStore.getState().setPin('123456');
    await useAuthStore.getState().verifyPin('000000');
    expect(prefs.get('auth.pinFailedAttempts')).toBe('1');
    await clearPin();
    expect(prefs.has('auth.pin')).toBe(false);
    expect(prefs.has('auth.pinFailedAttempts')).toBe(false);
    expect(prefs.has('auth.pinLastFailAt')).toBe(false);
    await useAuthStore.getState().init();
    expect(useAuthStore.getState().hasPin).toBe(false);
  });
});

describe('Change PIN (Settings)', () => {
  it('the new PIN replaces the old one and resets the counters', async () => {
    await useAuthStore.getState().setPin('123456');
    await useAuthStore.getState().verifyPin('000000');
    expect((await useAuthStore.getState().verifyPin('123456')).ok).toBe(true);
    await useAuthStore.getState().setPin('222222');
    expect(prefs.has('auth.pinFailedAttempts')).toBe(false);
    expect((await useAuthStore.getState().verifyPin('222222')).ok).toBe(true);
    expect((await useAuthStore.getState().verifyPin('123456')).ok).toBe(false);
  });
});

// v1.22: a confirmation open when the app locks is answered "cancel"
// (ConfirmDialog subscribes through whenLocked).
describe('whenLocked', () => {
  it('fires on every unlocked → locked change, and never while no lock applies', () => {
    const fired = vi.fn();
    useAuthStore.setState({ unlocked: false });
    const stop = whenLocked(fired);
    useAuthStore.getState().lock(); // false → false: no app lock in use
    expect(fired).not.toHaveBeenCalled();
    useAuthStore.getState().unlock();
    useAuthStore.getState().lock();
    expect(fired).toHaveBeenCalledTimes(1);
    useAuthStore.getState().unlock();
    useAuthStore.setState({ autoLockMinutes: 1, lastActivity: Date.now() - 120_000 });
    useAuthStore.getState().bumpActivity(); // auto-lock
    expect(fired).toHaveBeenCalledTimes(2);
    stop();
    useAuthStore.getState().unlock();
    useAuthStore.getState().lock();
    expect(fired).toHaveBeenCalledTimes(2);
  });
});

describe('PIN lockout and the device clock (limecore#99)', () => {
  it('moving the clock forward does not end a lockout', async () => {
    await useAuthStore.getState().setPin('123456');
    for (let i = 0; i < 5; i++) await useAuthStore.getState().verifyPin('000000');
    expect(useAuthStore.getState().failedAttempts).toBe(5);
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 24 * 3600 * 1000; // a day ahead
      const r = await useAuthStore.getState().verifyPin('123456');
      expect(r.ok).toBe(false);
      expect(r.locked?.remainingSeconds).toBeGreaterThan(0);
    } finally {
      Date.now = realNow;
    }
  });

  it('a restart resumes the time left, whatever the clock says', async () => {
    await useAuthStore.getState().setPin('123456');
    for (let i = 0; i < 5; i++) await useAuthStore.getState().verifyPin('000000');
    expect(Number(prefs.get('auth.pinLockLeftMs'))).toBe(30_000);
    prefs.set('auth.pinLastFailAt', '1'); // a clock long past the lockout
    await useAuthStore.getState().init();
    const r = await useAuthStore.getState().verifyPin('123456');
    expect(r.ok).toBe(false);
  });

  it('the right PIN after the lockout clears it', async () => {
    await useAuthStore.getState().setPin('123456');
    for (let i = 0; i < 5; i++) await useAuthStore.getState().verifyPin('000000');
    prefs.set('auth.pinLockLeftMs', '0');
    await useAuthStore.getState().init();
    expect((await useAuthStore.getState().verifyPin('123456')).ok).toBe(true);
    expect(prefs.has('auth.pinLockLeftMs')).toBe(false);
  });
});
