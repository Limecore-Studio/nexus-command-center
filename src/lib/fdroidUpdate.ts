// v1.16 (#48) — "a newer NCC is on F-Droid", Android only. A port of
// StudyDesk's src/lib/fdroidUpdate.js (StudyDesk#67), same rules:
//
//   - F-Droid's own API, never GitHub Releases. F-Droid lags GitHub by one to
//     three days, and announcing a version the user cannot install yet is
//     worse than saying nothing.
//   - At most one request per 24 h. The attempt time is recorded whatever the
//     outcome, so a flaky connection cannot turn into a request per launch.
//   - Silent on every failure. Offline, an HTTP error, a malformed answer or a
//     package F-Droid does not know all mean "no notice", never an error.
//   - Never on the startup path: the caller fires it after first paint.
//   - Dismissing hides that version only; the next one is announced again.
//   - A Settings switch that stops the request entirely, as the privacy
//     policy promises (#50). Off means no network call, not merely no notice.
//     The request carries nothing about the user: it is a plain GET for a
//     public package record.
//   - v1.21.1 (limecore#87): opt-in, off until the owner says yes
//     (lib/usageConsent.ts). The old device-wide "on unless 'off'" key is no
//     longer read, so existing installs count as not asked.
//
// Desktop has its own updater (desktopUpdate.ts) and the web build is always
// current, so this is Android only. The request goes through CapacitorHttp
// (native), not fetch: f-droid.org's API sends no CORS headers, so a WebView
// fetch from the app origin would be refused before it left the device.
import { useSyncExternalStore } from 'react';
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { App } from '@capacitor/app';
import { consented, setConsent } from './usageConsent';

const PACKAGE = 'com.limecore.nexus';
export const FDROID_PAGE = `https://f-droid.org/packages/${PACKAGE}/`;
const API = `https://f-droid.org/api/v1/packages/${PACKAGE}`;
const DAY_MS = 24 * 60 * 60 * 1000;

// The consent is per owner (usageConsent); the cache and the dismissal stay
// device-local.
const KEY_LAST = 'nexus.fdroidLast'; // { at, code, name } of the last answer
const KEY_DISMISSED = 'nexus.fdroidDismissed'; // versionCode the user dismissed

export interface VersionRef {
  code: number;
  name: string;
}
export interface UpdateAvailable {
  current: VersionRef;
  latest: VersionRef;
}
interface State {
  enabled: boolean;
  available: UpdateAvailable | null;
}
interface HttpLike {
  get(options: { url: string; connectTimeout?: number; readTimeout?: number }): Promise<{ status: number; data: unknown }>;
}
interface AppLike {
  getInfo(): Promise<{ version?: string; build?: string }>;
}
interface FdroidAnswer {
  suggestedVersionCode?: unknown;
  packages?: { versionName?: unknown; versionCode?: unknown }[];
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* storage unavailable: the check simply runs again next time */
  }
}

// ── A tiny store, so the note and the Settings switch agree ───────────────
let state: State = { enabled: consented('updateCheck'), available: null };
const listeners = new Set<() => void>();
function set(next: Partial<State>): void {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
}
function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
export function useFdroidUpdate(): State {
  return useSyncExternalStore(subscribe, () => state, () => state);
}

export function setUpdateCheckEnabled(on: boolean): void {
  setConsent('updateCheck', on);
  // Off also forgets what was known, so turning it back on starts clean
  // rather than resurfacing a stale answer from before.
  if (!on) write(KEY_LAST, null);
  set({ enabled: on, available: on ? state.available : null });
}

export function dismissUpdate(): void {
  if (state.available) write(KEY_DISMISSED, String(state.available.latest.code));
  set({ available: null });
}

/** F-Droid's suggested version, from cache when it is under a day old. */
async function latestOnFdroid(now: number, http: HttpLike): Promise<(VersionRef & { at: number }) | null> {
  let cached: { at?: unknown; code?: unknown; name?: unknown } | null = null;
  try {
    cached = JSON.parse(read(KEY_LAST) ?? 'null');
  } catch {
    /* ignore */
  }
  if (cached && typeof cached.at === 'number' && now - cached.at < DAY_MS && now >= cached.at) {
    return typeof cached.code === 'number' && cached.code > 0
      ? { at: cached.at, code: cached.code, name: typeof cached.name === 'string' ? cached.name : '' }
      : null;
  }
  // Recorded before the request, so a failure still counts against the day.
  write(KEY_LAST, JSON.stringify({ at: now, code: 0, name: '' }));
  const res = await http.get({ url: API, connectTimeout: 8000, readTimeout: 8000 });
  if (!res || res.status !== 200 || !res.data) return null;
  const body = (typeof res.data === 'string' ? JSON.parse(res.data) : res.data) as FdroidAnswer;
  const code = Number(body?.suggestedVersionCode);
  if (!Number.isInteger(code) || code <= 0) return null;
  const match = (body.packages ?? []).find((p) => p?.versionCode === code)?.versionName;
  const answer = { at: now, code, name: typeof match === 'string' ? match.slice(0, 32) : '' };
  write(KEY_LAST, JSON.stringify(answer));
  return answer;
}

/**
 * Run the check once. Resolves to `{ current, latest }` when F-Droid has a
 * newer build than this one and the user has not dismissed that version,
 * otherwise null. Never throws. Dependencies are injectable for tests.
 */
export async function checkFdroidUpdate({
  now = Date.now(),
  http = CapacitorHttp as HttpLike,
  app = App as AppLike,
  platform = Capacitor.getPlatform(),
}: { now?: number; http?: HttpLike; app?: AppLike; platform?: string } = {}): Promise<UpdateAvailable | null> {
  try {
    // Read now, not at load: the owner may have changed since.
    if (state.enabled !== consented('updateCheck')) set({ enabled: consented('updateCheck') });
    if (platform !== 'android' || !state.enabled) return null;
    const latest = await latestOnFdroid(now, http);
    if (!latest) return null;
    const info = await app.getInfo();
    const running = Number(info?.build);
    if (!Number.isInteger(running) || latest.code <= running) return null;
    if (read(KEY_DISMISSED) === String(latest.code)) return null;
    const available: UpdateAvailable = {
      current: { code: running, name: info.version ?? '' },
      latest: { code: latest.code, name: latest.name },
    };
    // The switch may have been turned off while the request was in flight.
    if (!consented('updateCheck')) return null;
    set({ available });
    return available;
  } catch {
    return null;
  }
}

/** Test-only: forget module state between cases. */
export function resetFdroidUpdateForTests(): void {
  state = { enabled: consented('updateCheck'), available: null };
}
