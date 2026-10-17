// Guest-mode flag — lets users skip the first-launch login screen and use
// NCC locally without a Supabase session. Cloud sync (Supabase, Realtime,
// SSO bridge) is disabled in guest mode; everything else (Dexie state,
// portfolio refresh, Yahoo/Finnhub APIs, notifications) works identically.
//
// Stored in Capacitor Preferences (Android SharedPreferences) under the key
// `nexus.guestMode` with value `"1"` for on / removed for off. The value is
// a STRING because Capacitor Preferences only supports string values — see
// the SessionContentProvider class header for the full type-mismatch story.
//
// State transitions:
//   First launch       → flag absent → Login screen shown
//   Tap Continue Guest → flag set    → Login dismissed, app loads
//   Sign in from guest → flag cleared (Settings "Sign In" path)
//   Sign out           → flag cleared (so the user lands on Login again,
//                       not back into a half-authenticated guest state)
//
// On web/dev the Preferences plugin works on localStorage so the flag still
// persists across reloads without any special handling.

import { Preferences } from '@capacitor/preferences';

const KEY = 'nexus.guestMode';

// v1.18.1 (NCC#186) — the last value read or written, for callers that must
// answer synchronously (the reminder gate in lib/notifications.ts). App.tsx
// reads the flag at startup, before anything can schedule a reminder.
let known = false;

/** v1.18.1 (NCC#186) — the guest flag as last read or written; false until then. */
export function isGuestModeKnown(): boolean {
  return known;
}

export async function isGuestMode(): Promise<boolean> {
  try {
    const { value } = await Preferences.get({ key: KEY });
    known = value === '1';
    return known;
  } catch {
    return false;
  }
}

export async function setGuestMode(enabled: boolean): Promise<void> {
  known = enabled;
  try {
    if (enabled) {
      await Preferences.set({ key: KEY, value: '1' });
    } else {
      await Preferences.remove({ key: KEY });
    }
  } catch {
    /* swallow — best-effort flag */
  }
}
