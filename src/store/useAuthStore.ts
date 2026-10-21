// Local auth — PIN + biometric. Holds no sensitive material in memory; the
// PIN hash lives in Capacitor Preferences and is verified on every unlock.
//
// PIN HASH FORMAT
// ──────────────────────────────────────────────────────────────────────────
//   v2:<salt_b64>:<hash_b64>          (current — PBKDF2-SHA256, 250k iters)
//   <64 hex chars>                    (v1 legacy — bare SHA-256, no salt)
//
// v1 was unsalted SHA-256, which is precomputable against a 6-digit PIN in
// well under a second. We can't force-migrate without making the user enter
// their PIN (the salt is derived from a successful verification), so on every
// successful unlock against a v1 hash we transparently re-hash with v2 and
// write that back. After one unlock, the stored format is upgraded.
//
// BRUTE-FORCE PROTECTION
// ──────────────────────────────────────────────────────────────────────────
// Failed PIN attempts are persisted across app restarts (counter + last-fail
// timestamp). Lockout windows are tiered:
//
//   5 failures   →  30 sec   (slows scripted attacks)
//   10 failures  →   5 min   (kills "let me try a hundred more")
//   20 failures  →  15 min   (a 6-digit space brute force becomes years)
//
// The counter resets only on successful unlock or on `setPin` (e.g. after
// "Clear All Data" recovery). Lockout is enforced server-of-truth here, BUT
// because all state is local, the threat model is "stolen unlocked device"
// or "rooted device with adb shell input" — a sufficiently determined
// adversary can still attack the on-disk hash directly. PBKDF2 + salt makes
// that attack expensive (~250k SHA-256 per guess); real at-rest encryption
// of the IndexedDB is the next defense-in-depth step (tracked separately).

import { create } from 'zustand';
import { Preferences } from '@capacitor/preferences';
import {
  KEYSTORE_ALIAS_PIN,
  decrypt as keystoreDecrypt,
  encrypt as keystoreEncrypt,
  ensureKey as keystoreEnsureKey,
  keystoreAvailable,
} from '@/lib/keystore';

const PIN_KEY = 'auth.pin';
const AUTOLOCK_KEY = 'auth.autoLockMin';
const BIOMETRIC_KEY = 'auth.biometricEnabled';
const PIN_ATTEMPTS_KEY = 'auth.pinFailedAttempts';
const PIN_LAST_FAIL_KEY = 'auth.pinLastFailAt';

const PBKDF2_ITERATIONS = 250_000;
const SALT_BYTES = 16;
const HASH_FORMAT_VERSION = 'v2';
// v1.4 — outer wrapper that AKS-encrypts the v2 string. Format:
//   v3:<iv_b64>:<ciphertext_b64>
// Decryption requires the Android Keystore-bound key under
// KEYSTORE_ALIAS_PIN. On Keystore failure (web dev, very old Android,
// or revoked key) we silently fall back to v2 plaintext storage so
// auth continues to work.
const KEYSTORE_WRAPPER_VERSION = 'v3';

// Lockout schedule — cumulative: at N failed attempts, lock for X seconds.
// Highest threshold wins (i.e. 20 attempts → 15min, not the sum).
const LOCKOUT_TIERS: Array<{ attempts: number; lockSeconds: number }> = [
  { attempts: 20, lockSeconds: 15 * 60 },
  { attempts: 10, lockSeconds: 5 * 60 },
  { attempts: 5, lockSeconds: 30 },
];

// ── Preferences helpers ───────────────────────────────────────────────────

async function getPref(key: string): Promise<string | null> {
  try {
    const { value } = await Preferences.get({ key });
    return value;
  } catch {
    return localStorage.getItem(key);
  }
}
async function setPref(key: string, value: string): Promise<void> {
  try {
    await Preferences.set({ key, value });
  } catch {
    localStorage.setItem(key, value);
  }
}
async function removePref(key: string): Promise<void> {
  try {
    await Preferences.remove({ key });
  } catch {
    localStorage.removeItem(key);
  }
}

// ── Crypto primitives ─────────────────────────────────────────────────────

function b64encode(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function pbkdf2(pin: string, salt: Uint8Array): Promise<string> {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(pin),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    baseKey,
    256,
  );
  return b64encode(new Uint8Array(bits));
}

// Legacy v1: bare 64-hex SHA-256 of the PIN. Used only to verify-and-upgrade
// existing users' stored hashes.
async function legacySha256(pin: string): Promise<string> {
  const enc = new TextEncoder().encode(pin);
  const buf = await crypto.subtle.digest('SHA-256', enc);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function isLegacyHash(stored: string): boolean {
  return /^[0-9a-f]{64}$/.test(stored);
}

function parseV2(stored: string): { salt: Uint8Array; hash: string } | null {
  const parts = stored.split(':');
  if (parts.length !== 3 || parts[0] !== HASH_FORMAT_VERSION) return null;
  try {
    return { salt: b64decode(parts[1]), hash: parts[2] };
  } catch {
    return null;
  }
}

async function hashPinV2(pin: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await pbkdf2(pin, salt);
  return `${HASH_FORMAT_VERSION}:${b64encode(salt)}:${hash}`;
}

// Constant-time string compare. Important even locally: if a future feature
// exposes verifyPin to repeated automated calls (e.g. via a webhook or test
// harness), early-exit `===` leaks PIN bytes via response timing.
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ── v3 Keystore wrapper ─────────────────────────────────────────────────
//
// Encrypts the v2 (or legacy v1) hash string with an AndroidKeyStore-bound
// AES-256-GCM key. The wrapper protects against attackers who pull
// SharedPreferences via adb backup, a rooted-ADB shell, or a leaked
// MODE_PRIVATE bypass: the v2 string is salted-PBKDF2 hash that's still
// expensive to brute-force, but v3 turns that into a fully-AEAD-encrypted
// blob whose key can't be extracted from user space.
//
// Defense-in-depth, not a panacea. Determined adversaries with full root +
// secure-element exploits can still attack the device. AKS raises the bar
// from "trivial" to "expensive + device-specific."

function isV3Wrapped(stored: string): boolean {
  return stored.startsWith(`${KEYSTORE_WRAPPER_VERSION}:`);
}

function parseV3(stored: string): { iv: string; ciphertext: string } | null {
  const parts = stored.split(':');
  if (parts.length !== 3 || parts[0] !== KEYSTORE_WRAPPER_VERSION) return null;
  return { iv: parts[1], ciphertext: parts[2] };
}

/** Encrypt a v1/v2 hash string and produce the v3 wrapped form. Throws if
 *  Keystore isn't available — caller must decide whether to fall back. */
async function wrapV3(plaintextV2: string): Promise<string> {
  await keystoreEnsureKey(KEYSTORE_ALIAS_PIN);
  const { iv, ciphertext } = await keystoreEncrypt(KEYSTORE_ALIAS_PIN, plaintextV2);
  return `${KEYSTORE_WRAPPER_VERSION}:${iv}:${ciphertext}`;
}

/** v1.18.1 (limecore#58): wrap, then read it back. Returns the v3 form only
 *  if it decrypts to the input, otherwise null so the caller keeps v2: a v3
 *  PIN this device can't read would leave the app locked. */
async function wrapVerifiedV3(plaintextV2: string): Promise<string | null> {
  const wrapped = await wrapV3(plaintextV2);
  return (await unwrapV3(wrapped)) === plaintextV2 ? wrapped : null;
}

/** Unwrap a stored value back to the v1/v2 form. Returns null on any
 *  decrypt failure (key missing, tampered ciphertext, etc.) so callers
 *  can present a clean "PIN unrecoverable, please re-set" path. */
async function unwrapV3(stored: string): Promise<string | null> {
  const v3 = parseV3(stored);
  if (!v3) return null;
  try {
    return await keystoreDecrypt(KEYSTORE_ALIAS_PIN, v3.ciphertext, v3.iv);
  } catch (e) {
    console.warn('[auth] v3 PIN decrypt failed:', (e as Error).message);
    return null;
  }
}

function getLockoutSecondsForAttempts(attempts: number): number {
  for (const tier of LOCKOUT_TIERS) {
    if (attempts >= tier.attempts) return tier.lockSeconds;
  }
  return 0;
}

// ── Store ─────────────────────────────────────────────────────────────────

interface VerifyResult {
  ok: boolean;
  // Present when verification was refused (or just rejected) due to lockout.
  // `remainingSeconds` is the wall-clock seconds the UI should show.
  locked?: { until: number; remainingSeconds: number; totalAttempts: number };
  // v1.18.1 (limecore#58): the stored PIN could not be decrypted on this
  // device, so the entry was never compared. Not counted as a wrong guess.
  unreadable?: boolean;
}

interface AuthStore {
  unlocked: boolean;
  hasPin: boolean;
  biometricEnabled: boolean;
  autoLockMinutes: number;
  lastActivity: number;
  /** Epoch ms; 0 = not currently locked out. Surface this in UI for countdown. */
  lockedUntil: number;
  failedAttempts: number;
  /** v1.18.1 (limecore#58): a PIN is stored but this device can't decrypt it
   *  right now. The app stays locked; LockScreen explains the way out. */
  pinUnreadable: boolean;
  /** True once init() has read the stored PIN state. Until then App shows the
   *  splash rather than LockScreen, which would otherwise start in "set a PIN"
   *  mode because hasPin is still its default. */
  ready: boolean;

  init: () => Promise<void>;
  setPin: (pin: string) => Promise<void>;
  verifyPin: (pin: string) => Promise<VerifyResult>;
  unlock: () => void;
  lock: () => void;
  bumpActivity: () => void;
  setBiometric: (on: boolean) => Promise<void>;
  setAutoLock: (minutes: number) => Promise<void>;
}

export const useAuthStore = create<AuthStore>((set, get) => ({
  unlocked: false,
  hasPin: false,
  biometricEnabled: true,
  autoLockMinutes: 5,
  lastActivity: Date.now(),
  lockedUntil: 0,
  failedAttempts: 0,
  pinUnreadable: false,
  ready: false,

  async init() {
    const [pin, autoLock, bio, attempts, lastFailAt] = await Promise.all([
      getPref(PIN_KEY),
      getPref(AUTOLOCK_KEY),
      getPref(BIOMETRIC_KEY),
      getPref(PIN_ATTEMPTS_KEY),
      getPref(PIN_LAST_FAIL_KEY),
    ]);

    // v1.4 — opportunistic v2 → v3 migration. If we find a plaintext v2
    // hash AND Keystore is available, encrypt-in-place. One-shot per
    // user. On Keystore failure we leave v2 alone (auth still works,
    // just without the AKS layer of defense).
    if (pin && !isV3Wrapped(pin) && !isLegacyHash(pin) && keystoreAvailable()) {
      try {
        const wrapped = await wrapVerifiedV3(pin);
        if (wrapped) await setPref(PIN_KEY, wrapped);
      } catch (e) {
        console.warn('[auth] PIN v3 migration skipped:', (e as Error).message);
      }
    }
    // v1.18.1 (limecore#58): a v3 PIN that fails to decrypt is kept, and the
    // app stays locked. A decrypt failure can be transient; when it isn't, the
    // way out is the forgot-PIN one (clear the app's data), the same as for a
    // forgotten PIN. Biometric unlock still works meanwhile.
    let pinUnreadable = false;
    if (pin && isV3Wrapped(pin)) {
      pinUnreadable = (await unwrapV3(pin)) == null;
    }

    // Coerce legacy "Never auto-lock" (saved as 0) to a 60-minute cap. The
    // "Never" option was removed for security reasons; existing users get
    // bumped to the longest sane window instead of staying perpetually
    // unlocked.
    let autoLockMin = autoLock ? Number(autoLock) : 5;
    if (!Number.isFinite(autoLockMin) || autoLockMin <= 0) autoLockMin = 60;

    const failedAttempts = attempts ? Number(attempts) : 0;
    const lastFail = lastFailAt ? Number(lastFailAt) : 0;
    const lockoutSec = getLockoutSecondsForAttempts(failedAttempts);
    const lockedUntilCandidate = lastFail && lockoutSec > 0 ? lastFail + lockoutSec * 1000 : 0;

    set({
      hasPin: !!pin,
      pinUnreadable,
      ready: true,
      autoLockMinutes: autoLockMin,
      biometricEnabled: bio !== '0',
      failedAttempts,
      lockedUntil: lockedUntilCandidate > Date.now() ? lockedUntilCandidate : 0,
    });
  },

  async setPin(pin) {
    const v2 = await hashPinV2(pin);
    // v1.4 — wrap with Keystore when available; fall back to plaintext v2
    // on web dev or when Keystore is broken.
    let toStore = v2;
    if (keystoreAvailable()) {
      try {
        toStore = (await wrapVerifiedV3(v2)) ?? v2;
      } catch (e) {
        console.warn('[auth] PIN encryption skipped, storing v2 plaintext:', (e as Error).message);
      }
    }
    await setPref(PIN_KEY, toStore);
    // Fresh PIN → wipe lockout state so the user isn't punished for whatever
    // PIN they were guessing before resetting.
    await removePref(PIN_ATTEMPTS_KEY);
    await removePref(PIN_LAST_FAIL_KEY);
    set({ hasPin: true, pinUnreadable: false, failedAttempts: 0, lockedUntil: 0 });
  },

  async verifyPin(pin) {
    const now = Date.now();
    const state = get();

    // Hard gate on lockout — don't even compute the hash if locked out, both
    // to surface the lockout cleanly and to deny the attacker any
    // unintended timing signal.
    if (state.lockedUntil > now) {
      return {
        ok: false,
        locked: {
          until: state.lockedUntil,
          remainingSeconds: Math.ceil((state.lockedUntil - now) / 1000),
          totalAttempts: state.failedAttempts,
        },
      };
    }

    const stored = await getPref(PIN_KEY);
    if (!stored) return { ok: false };

    // v1.4 — unwrap the v3 AKS layer if present. Everything below works on
    // the v1/v2 plaintext form.
    let plaintextHash = stored;
    if (isV3Wrapped(stored)) {
      const unwrapped = await unwrapV3(stored);
      if (unwrapped == null) {
        // Key unreachable or ciphertext tampered. Not a guess, so it doesn't
        // count toward the lockout; the PIN stays (limecore#58).
        set({ pinUnreadable: true });
        return { ok: false, unreadable: true };
      }
      if (state.pinUnreadable) set({ pinUnreadable: false });
      plaintextHash = unwrapped;
    }

    let matched: boolean;

    if (isLegacyHash(plaintextHash)) {
      // v1 path: legacy unsalted SHA-256. Verify, and on success transparently
      // upgrade to v2 so subsequent unlocks use the safer hash. The v2
      // string then goes through wrapV3 if Keystore is available.
      const candidate = await legacySha256(pin);
      matched = timingSafeEqual(candidate, plaintextHash);
      if (matched) {
        const upgradedV2 = await hashPinV2(pin);
        let toStore = upgradedV2;
        if (keystoreAvailable()) {
          try { toStore = (await wrapVerifiedV3(upgradedV2)) ?? upgradedV2; } catch { /* fall back */ }
        }
        await setPref(PIN_KEY, toStore);
      }
    } else {
      const v2 = parseV2(plaintextHash);
      if (!v2) return { ok: false };
      const candidate = await pbkdf2(pin, v2.salt);
      matched = timingSafeEqual(candidate, v2.hash);
    }

    if (matched) {
      await removePref(PIN_ATTEMPTS_KEY);
      await removePref(PIN_LAST_FAIL_KEY);
      set({ failedAttempts: 0, lockedUntil: 0 });
      return { ok: true };
    }

    // Bump and persist the failure counter.
    const nextAttempts = state.failedAttempts + 1;
    await setPref(PIN_ATTEMPTS_KEY, String(nextAttempts));
    await setPref(PIN_LAST_FAIL_KEY, String(now));
    const lockoutSec = getLockoutSecondsForAttempts(nextAttempts);
    const newLockedUntil = lockoutSec > 0 ? now + lockoutSec * 1000 : 0;
    set({ failedAttempts: nextAttempts, lockedUntil: newLockedUntil });

    if (newLockedUntil > 0) {
      return {
        ok: false,
        locked: {
          until: newLockedUntil,
          remainingSeconds: lockoutSec,
          totalAttempts: nextAttempts,
        },
      };
    }
    return { ok: false };
  },

  unlock() {
    set({ unlocked: true, lastActivity: Date.now() });
  },

  lock() {
    set({ unlocked: false });
  },

  bumpActivity() {
    // v1.18.1 (limecore#58): activity after the idle limit has passed locks
    // rather than restarting the idle clock, so the outcome no longer depends
    // on whether the 30 s tick ran first. `unlocked` is only ever true where
    // the app lock applies (LockScreen is the only caller of unlock()), so
    // this is inert on web and desktop.
    const { unlocked, autoLockMinutes, lastActivity } = get();
    const now = Date.now();
    if (unlocked && autoLockMinutes > 0 && now - lastActivity > autoLockMinutes * 60_000) {
      set({ unlocked: false });
      return;
    }
    set({ lastActivity: now });
  },

  async setBiometric(on) {
    await setPref(BIOMETRIC_KEY, on ? '1' : '0');
    set({ biometricEnabled: on });
  },

  async setAutoLock(minutes) {
    await setPref(AUTOLOCK_KEY, String(minutes));
    set({ autoLockMinutes: minutes });
  },
}));
