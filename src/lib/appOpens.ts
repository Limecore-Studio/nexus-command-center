// v1.12 Item 0 — retention instrumentation.
//
// One row per user per app per day, written when the app comes to the
// foreground. Ported from StudyDesk's `src/lib/appOpens.js`; the reasoning is
// repeated here rather than cross-referenced, because each of these decisions
// is one somebody would otherwise quietly undo.
//
// **Foreground, not sign-in.** Sign-in is precisely the event `SESS-1`
// corrupted — the daily forced sign-out meant `last_sign_in_at` recorded a bug
// rather than a habit. "Came back" is the app being opened.
//
// **Local date, not UTC.** `new Date().toISOString().slice(0,10)` is the *UTC*
// date. In UTC+3 at 00:30 local that yields the previous day, so two real days
// collapse into one bucket. Day bucketing is the entire point of the table, and
// this is the same class of drift NCC's own 1.10.1 hotfix existed to fix.
//
// **Queued, not pushed.** A cold start can foreground before the session has
// been restored, and RLS rejects the write with no session; the device is also
// often offline at exactly that moment. The queue turns both into a retry
// rather than a lost day — and unlike the sibling apps' outboxes, NCC's queue
// drops permanently-failing items (42501 RLS denial is in PERMANENT_PG_CODES)
// instead of retrying forever, so a stray open cannot wedge the queue.
//
// **Opt-in (v1.21.1, limecore#87).** Nothing is queued or sent unless this
// account said yes (lib/usageConsent.ts). Not asked counts as no.

import { Capacitor } from '@capacitor/core';
import { IS_DESKTOP } from './isDesktop';
import { enqueue } from '../db/syncQueue';
import { supabase } from './supabase';
import { consented } from './usageConsent';
import { generateId } from '../utils/uuid';
import pkg from '../../package.json';

const LAST_KEY = 'ncc.lastAppOpen';

/** The user's own calendar date, not UTC's. See the header. */
function localDay(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** One of 'android' | 'desktop' | 'web' — the values the table's CHECK allows. */
function platform(): string {
  if (Capacitor.isNativePlatform()) {
    return Capacitor.getPlatform() === 'android' ? 'android' : 'web';
  }
  // Same check, now shared with the desktop app-lock exemption — see
  // `lib/isDesktop.ts`. Lifted out rather than copied so the two can never
  // disagree about what "desktop" means.
  if (IS_DESKTOP) return 'desktop';
  return 'web';
}

/**
 * Record today's open, at most once per local day.
 *
 * The localStorage guard is a cost control, not correctness — the composite
 * primary key already makes the write idempotent, so a duplicate would only
 * waste a queue slot on every tab switch.
 */
export async function recordAppOpen(): Promise<boolean> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return false;
  if (!consented('appOpens', session.user.id)) return false;

  const today = localDay();
  try {
    if (localStorage.getItem(LAST_KEY) === today) return false;
  } catch {
    // Blocked storage — fall through and queue; the primary key still
    // collapses the duplicate server-side.
  }
  await enqueue('app_open', generateId(), 'insert', {
    appVersion: pkg.version,
    platform: platform(),
    openedOn: today,
  });
  try { localStorage.setItem(LAST_KEY, today); } catch { /* see above */ }
  return true;
}

/**
 * Wire foreground detection. Returns an unsubscribe function.
 *
 * Both triggers are needed: the initial call covers a cold start, and
 * visibilitychange covers the commoner case of the app being resumed days later
 * without the process ever having died.
 */
export function watchAppOpens(): () => void {
  void recordAppOpen();
  if (typeof document === 'undefined') return () => {};
  const onVisible = () => {
    if (document.visibilityState === 'visible') void recordAppOpen();
  };
  document.addEventListener('visibilitychange', onVisible);
  return () => document.removeEventListener('visibilitychange', onVisible);
}
