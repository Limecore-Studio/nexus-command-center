// v1.21.1 (NCC#259) — remove the PIN and its attempt counters. They live in
// Preferences, which Clear All Data's wipe did not reach. Its own module, not
// a store action, so it loads with its two callers (Settings, ForgotPinPanel)
// instead of at startup (scripts/check-bundle-size.mjs).
import { PIN_ATTEMPTS_KEY, PIN_KEY, PIN_LAST_FAIL_KEY, removePref, useAuthStore } from '../store/useAuthStore';

export async function clearPin(): Promise<void> {
  await removePref(PIN_KEY);
  await removePref(PIN_ATTEMPTS_KEY);
  await removePref(PIN_LAST_FAIL_KEY);
  useAuthStore.setState({ hasPin: false, pinUnreadable: false, failedAttempts: 0, lockedUntil: 0 });
}
