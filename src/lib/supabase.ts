// Supabase client.
// - PKCE flow (required for mobile — never use implicit on Capacitor).
// - Sessions persisted via Capacitor Preferences (SharedPreferences on Android,
//   more durable than WebView localStorage which can be evicted under pressure).
// - detectSessionInUrl off — we handle OAuth callbacks manually via the deep-link
//   listener in App.tsx so we control when exchangeCodeForSession fires.
//
// The publishable key is safe to ship in client code (it's gated by RLS — the
// real authority is the user's signed JWT, not this key).
import { createClient, type Session, type SupportedStorage } from '@supabase/supabase-js';
import { Preferences } from '@capacitor/preferences';
import { App as CapacitorApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { DESKTOP_REDIRECT_URL } from './desktop';

const SUPABASE_URL = 'https://hkktorzhaqnfqsnlstda.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_ykHLJ4QuFm2HKXACygwezw_c_cvR_yf';

const capacitorStorage: SupportedStorage = {
  async getItem(key) {
    try {
      const { value } = await Preferences.get({ key });
      return value;
    } catch {
      return localStorage.getItem(key);
    }
  },
  async setItem(key, value) {
    try {
      await Preferences.set({ key, value });
    } catch {
      localStorage.setItem(key, value);
    }
  },
  async removeItem(key) {
    try {
      await Preferences.remove({ key });
    } catch {
      localStorage.removeItem(key);
    }
  },
};

// v1.19 — NCC#139: no request used to have a time limit. On Wi-Fi with no
// route (or a captive portal) a request can stay pending forever, and every
// await behind it — a sync, the "Existing data found" prompt — sat on
// "Working…" with it. 30 s is far past any healthy response (the slowest
// call, the delete-account function, answers in a few seconds) and NCC has no
// storage uploads, so nothing legitimate is cut off. A caller's own signal
// still aborts as before.
const REQUEST_TIMEOUT_MS = 30_000;

export function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const outer = init.signal;
  if (outer) {
    if (outer.aborted) controller.abort();
    else outer.addEventListener('abort', () => controller.abort(), { once: true });
  }
  return fetch(input, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

const SESSION_STORAGE_KEY = 'nexus-supabase-session';

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  global: { fetch: fetchWithTimeout },
  auth: {
    storage: capacitorStorage,
    storageKey: SESSION_STORAGE_KEY,
    autoRefreshToken: true,
    persistSession: true,
    // Native handles the OAuth callback manually via the deep-link listener in
    // App.tsx, so supabase-js must not race it. On WEB there is no deep-link
    // listener — nothing else will ever consume the `?code=` — so leaving this
    // false there meant the session was dropped even when the redirect was
    // correct. The second half of the same bug as OAUTH_REDIRECT_URL below.
    detectSessionInUrl: !Capacitor.isNativePlatform(),
    flowType: 'pkce',
  },
});

/** v1.19 — NCC#135: the persisted session exactly as supabase-js stored it,
 *  read without any network. getSession() refreshes an expired access token
 *  before it answers, and offline that refresh retries for ~25 s or more;
 *  cold start reads this instead so the app can open on the account it
 *  already has. Null when there is no stored session or it can't be parsed.
 *  The token inside may be expired — use it for WHO is signed in, never as a
 *  credential. */
export async function readStoredSession(): Promise<Session | null> {
  try {
    const raw = await capacitorStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Session> | null;
    if (!parsed || typeof parsed !== 'object' || !parsed.user?.id || !parsed.refresh_token) {
      return null;
    }
    return parsed as Session;
  } catch {
    return null;
  }
}

// ── Mobile session durability (v1.7 — forced-logout bug) ────────────────
// supabase-js drives its token auto-refresh loop off browser visibility /
// `online` events. In a Capacitor Android WebView those fire unreliably once
// the app is paused, so a backgrounded app can sail past the access-token
// expiry without refreshing; by the time it's reopened the rotating refresh
// token has lapsed, supabase-js emits SIGNED_OUT, and the user is bounced to
// the login screen — the spontaneous "logged out again" every day or two.
//
// Supabase's documented mobile fix is to drive the refresh loop off the
// native app lifecycle instead of browser events: stop it on background,
// (re)start it on foreground. startAutoRefresh() also runs an immediate tick,
// so a token that expired while backgrounded is refreshed from the still-valid
// refresh token the moment the app returns — keeping the session alive
// indefinitely. Cold start is already covered by getSession() in
// useSessionStore.init(); this closes the warm-foreground gap.
if (Capacitor.isNativePlatform()) {
  void CapacitorApp.addListener('appStateChange', ({ isActive }) => {
    if (isActive) {
      void supabase.auth.startAutoRefresh();
    } else {
      void supabase.auth.stopAutoRefresh();
    }
  });
}

// Where Supabase sends the browser back to after Google sign-in.
//
// NATIVE: a custom URL scheme, registered in AndroidManifest.xml and caught by
// the `appUrlOpen` listener in App.tsx, which then calls
// exchangeCodeForSession.
//
// WEB: the app's own origin. This branch is why the owner's report happened —
// the constant used to be the native scheme unconditionally, and a BROWSER
// cannot navigate to `com.limecore.nexus://login-callback`. Supabase fell back
// to the project's Site URL (limecore.dev/confirmed), which is where the
// session landed instead of in the app, leaving the user signed out. It broke
// on localhost and would have broken identically on any hosted web build.
//
// `window.location.origin` rather than a hardcoded host so dev
// (http://localhost:5173) and any deployed origin both work without a build
// flag — but note that EVERY origin still has to be listed in Supabase's
// Auth → URL Configuration → Redirect URLs allowlist, or Supabase silently
// falls back to the Site URL again and the symptom returns unchanged.
//
// DESKTOP is the third case, and v1.12 did not have it. In Electron
// `Capacitor.isNativePlatform()` is false (there is no Capacitor bridge) and
// `window.location.origin` is `nexus://app` — a custom scheme, which Supabase's
// redirect allow-list cannot hold, so every desktop sign-in fell back to the
// Site URL and parked the app's own window on the marketing site with no route
// back. The desktop shell now listens on a fixed loopback port and passes that
// URL in; see `electron/main.cjs`. A null means the listener could not bind, in
// which case the origin fallback below is no worse than what shipped.
export const OAUTH_REDIRECT_URL = Capacitor.isNativePlatform()
  ? 'com.limecore.nexus://login-callback'
  : DESKTOP_REDIRECT_URL || `${window.location.origin}/`;
