// Supabase Realtime → automatic pull-on-change.
//
// We subscribe to WAL-streamed postgres_changes on every table the app
// syncs. RLS is enforced per subscriber, so we only receive events for rows
// we could SELECT (i.e. owned + shared rows). On any event, we schedule a
// coalesced pull-and-merge into Dexie.
//
// Why coalesce: a burst of edits (e.g. another device syncing 10 items)
// would otherwise trigger 10 pulls. We collapse them into one pull on a
// short timer.
//
// Why pull-everything: simpler than parsing each event's payload and
// applying it surgically. Pull is cheap (the largest tables are filtered by
// user_id at the server). If the row count ever grows large this is the
// first thing to optimize.
//
// v1.20 (NCC#221): a postgres_changes event still runs the full sync. A
// broadcast hint from another device (see the live sync section below) names
// its tables, and only those are pulled.
//
// v1.2.1 — AUDIT-FSG-5 hardening:
//   1. Per-subscription `filter: user_id=eq.<uid>` on every table that does
//      NOT have a sharing surface. RLS is still the security boundary (the
//      filter is server-side and defense-in-depth, not the only gate), but
//      it cuts WAL bandwidth dramatically and means a future RLS regression
//      on these tables can't quietly leak rows. Sharing-aware tables
//      (`budget_categories`, `tasks`, plus the share tables themselves)
//      stay unfiltered so rows shared TO the current user still reach the
//      subscription — RLS handles those correctly already.
//   2. Added the v1.2 tables that the previous TABLES list missed:
//      `habits`, `habit_completions`, `body_metrics`. Without them, cross-
//      device or sibling-app edits to habits / body metrics never reach
//      NCC until manual refresh.

import { supabase } from './supabase';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { useSyncStore, setPushAnnouncer } from '../store/useSyncStore';
import {
  HINT_APP, HINT_EVENT, DEVICE_ID, hintTopic, tablesFromHint, backoffMs, createTableBatcher,
} from './liveHints';
import { setRealtimeState } from './realtimeState';

// limecore#24: every table in the two lists below must be in the
// `supabase_realtime` publication, or the server rejects the whole channel.
// realtime.tables.test.ts fails on one that is not.

// Tables that scope per-user. These get the `user_id=eq.<uid>` filter so
// only the current user's WAL events reach NCC. (RLS does the same thing
// post-broadcast anyway — this is the defense-in-depth + bandwidth fix.)
export const USER_SCOPED_TABLES = [
  'transactions',
  'portfolio_holdings',
  'subjects',
  'grades',
  'workout_sessions',
  'workout_sets',
  // v2-B
  'study_sessions',
  // v2-D
  'portfolio_lots',
  // v3
  'manual_assets',
  'watchlist_items',
  // v3-Phase5
  'goals',
  // v1.2 — missing from the pre-AUDIT-FSG-5 TABLES list, now wired so
  // cross-device habit + body-metric edits reach NCC in realtime.
  'habits',
  'habit_completions',
  'body_metrics',
] as const;

// Tables that intentionally surface rows BEYOND the current user (sharing).
// `budget_categories` and `tasks` can carry rows owned by another user when
// that user granted the current user a share — adding a `user_id=eq.<uid>`
// filter would suppress those events. The share-link tables (`*_shares`)
// have the same property by design. Leave these unfiltered; RLS handles
// scope correctly.
export const SHARING_AWARE_TABLES = [
  'budget_categories',
  'budget_category_shares',
  'tasks',
  'task_shares',
] as const;

// ── live sync (v1.20, NCC#221) ──────────────────────────────────────────────
//
// Two channels:
//   - `nexus-sync`: postgres_changes on every table above. The fallback, and
//     the only path for old StudyDesk/LimeLog builds writing into the shared
//     project. Any event still runs the full sync, coalesced.
//   - `user:<uid>`: private broadcast hints (liveHints.ts). A hint pulls only
//     the tables it names, ~300 ms after it arrives.
//
// Before v1.20 a channel that dropped stayed dead for the session: it only
// logged. Android drops the WebView's socket every time the app is
// backgrounded, so "live" was really the return-to-window sync. Now a dropped
// channel is removed and joined again, backing off 1 s → 30 s, and at once
// when the app comes back to the foreground or the network returns. Every
// rejoin runs one full sync to cover what happened while it was down.

let channel: RealtimeChannel | null = null;
let hintChannel: RealtimeChannel | null = null;
let pullTimer: ReturnType<typeof setTimeout> | null = null;
const COALESCE_MS = 1500;
const HINT_COALESCE_MS = 300;

function schedulePull() {
  if (pullTimer) return;
  pullTimer = setTimeout(() => {
    pullTimer = null;
    // syncNow is idempotent + serializes via the inflight promise chain, so
    // we don't have to worry about overlapping with the user's manual taps
    // or the background flusher.
    void useSyncStore.getState().syncNow();
  }, COALESCE_MS);
}

interface LiveSession {
  userId: string;
  joinedOnce: boolean;
  attempt: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
  hintAttempt: number;
  hintTimer: ReturnType<typeof setTimeout> | null;
  hintLive: boolean;
  hintsRefused: boolean;
  hintBatch: ReturnType<typeof createTableBatcher>;
  detach: () => void;
}
let live: LiveSession | null = null;

/** Hand Realtime the current access token before a rejoin. supabase-js
 *  forwards each refresh on its own, but a channel that died while the app
 *  slept may come back before that refresh has landed. */
async function refreshRealtimeAuth(): Promise<void> {
  try {
    const { data } = await supabase.auth.getSession();
    const token = data?.session?.access_token;
    if (token) await supabase.realtime.setAuth(token);
  } catch {
    /* the join reports its own failure */
  }
}

/**
 * Open live sync for a user.
 *
 * @param userId - The current signed-in user's auth.uid(). Used to scope
 *   user-scoped table subscriptions and to name the private hint topic.
 *   Sharing-aware tables ignore it.
 */
export function startRealtime(userId: string): void {
  // Already live for this user — keep it. A different user replaces it.
  if (live?.userId === userId) return;
  if (live) stopRealtime();
  const session: LiveSession = {
    userId,
    joinedOnce: false,
    attempt: 0,
    retryTimer: null,
    hintAttempt: 0,
    hintTimer: null,
    hintLive: false,
    hintsRefused: false,
    hintBatch: createTableBatcher((tables) => {
      void useSyncStore.getState().pullTables(tables);
    }, HINT_COALESCE_MS),
    detach: () => {},
  };
  live = session;
  joinChanges(session);
  joinHints(session);
  setPushAnnouncer(announceChanged);

  // `resume` is Capacitor's own foreground event on Android; the WebView's
  // visibilitychange is not always delivered after a long pause.
  const revive = () => reviveChannels(session);
  const onVisible = () => {
    if (document.visibilityState === 'visible') revive();
  };
  window.addEventListener('online', revive);
  document.addEventListener('visibilitychange', onVisible);
  document.addEventListener('resume', revive);
  session.detach = () => {
    window.removeEventListener('online', revive);
    document.removeEventListener('visibilitychange', onVisible);
    document.removeEventListener('resume', revive);
  };
}

function joinChanges(session: LiveSession): void {
  const c = supabase.channel('nexus-sync');
  for (const table of USER_SCOPED_TABLES) {
    c.on(
      'postgres_changes' as any,
      { event: '*', schema: 'public', table, filter: `user_id=eq.${session.userId}` },
      () => schedulePull()
    );
  }
  for (const table of SHARING_AWARE_TABLES) {
    c.on(
      'postgres_changes' as any,
      { event: '*', schema: 'public', table },
      () => schedulePull()
    );
  }
  // Limekana/limecore#24 — the server rejects the WHOLE channel for one table
  // missing from the `supabase_realtime` publication, with a `system` frame
  // sent after the join succeeded. Treated as a drop like any other.
  c.on('system' as any, {}, (payload: { status?: string; message?: string }) => {
    if (payload?.status === 'error') {
      console.warn('[realtime] subscription rejected:', payload.message ?? payload);
      dropChanges(session, c);
    }
  });
  channel = c;
  setRealtimeState('connecting');
  c.subscribe((status, err) => {
    // CLOSED after stopRealtime() or a drop is expected; `channel` has moved on.
    if (live !== session || channel !== c) return;
    if (status === 'SUBSCRIBED') {
      session.attempt = 0;
      setRealtimeState('live');
      // The first join of a session does not resync: App.tsx runs the launch
      // sync right after starting live sync.
      if (session.joinedOnce) void useSyncStore.getState().syncNow();
      session.joinedOnce = true;
      return;
    }
    console.warn(`[realtime] channel ${status}`, err?.message ?? '');
    dropChanges(session, c);
  });
}

function dropChanges(session: LiveSession, c: RealtimeChannel): void {
  if (live !== session || channel !== c) return;
  channel = null;
  void supabase.removeChannel(c);
  setRealtimeState('down');
  if (session.retryTimer) return;
  session.retryTimer = setTimeout(() => {
    session.retryTimer = null;
    void rejoinChanges(session);
  }, backoffMs(session.attempt++));
}

async function rejoinChanges(session: LiveSession): Promise<void> {
  await refreshRealtimeAuth();
  if (live !== session || channel) return;
  joinChanges(session);
}

function joinHints(session: LiveSession): void {
  const h = supabase.channel(hintTopic(session.userId), {
    config: { private: true, broadcast: { self: false } },
  });
  h.on('broadcast', { event: HINT_EVENT }, (msg: { payload?: unknown }) => {
    const tables = tablesFromHint(msg?.payload);
    if (tables.length) session.hintBatch.add(tables);
  });
  hintChannel = h;
  h.subscribe((status, err) => {
    if (live !== session || hintChannel !== h) return;
    if (status === 'SUBSCRIBED') {
      session.hintAttempt = 0;
      session.hintLive = true;
      return;
    }
    session.hintLive = false;
    hintChannel = null;
    void supabase.removeChannel(h);
    // Refused by Realtime Authorization: the server does not have the
    // `realtime.messages` policy yet (limecore#68). Retrying cannot fix that;
    // the postgres_changes channel still carries every edit, a little later.
    if (/unauthori[sz]ed|permission/i.test(err?.message ?? '')) {
      session.hintsRefused = true;
      console.info('[realtime] live hints unavailable:', err?.message);
      return;
    }
    console.warn(`[realtime] hint channel ${status}`, err?.message ?? '');
    if (session.hintTimer) return;
    session.hintTimer = setTimeout(() => {
      session.hintTimer = null;
      void rejoinHints(session);
    }, backoffMs(session.hintAttempt++));
  });
}

async function rejoinHints(session: LiveSession): Promise<void> {
  await refreshRealtimeAuth();
  if (live !== session || hintChannel || session.hintsRefused) return;
  joinHints(session);
}

const isDead = (c: RealtimeChannel | null) => !c || c.state === 'closed' || c.state === 'errored';

/** Foreground or back online: rejoin whatever is not live, now. */
function reviveChannels(session: LiveSession): void {
  if (live !== session) return;
  if (isDead(channel)) {
    if (channel) dropChanges(session, channel);
    if (session.retryTimer) clearTimeout(session.retryTimer);
    session.retryTimer = null;
    session.attempt = 0;
    void rejoinChanges(session);
  }
  if (!session.hintsRefused && isDead(hintChannel)) {
    if (hintChannel) {
      void supabase.removeChannel(hintChannel);
      hintChannel = null;
      session.hintLive = false;
    }
    if (session.hintTimer) clearTimeout(session.hintTimer);
    session.hintTimer = null;
    session.hintAttempt = 0;
    void rejoinHints(session);
  }
}

/**
 * Tell this user's other devices which tables a push just wrote. The sync
 * store calls it with the tables of items that succeeded, so a failed push
 * announces nothing. A no-op until the hint channel is joined: a send on an
 * unjoined channel would fall back to a REST call per table.
 */
export function announceChanged(tables: string[]): void {
  if (!live?.hintLive || !hintChannel) return;
  const at = Date.now();
  for (const table of new Set(tables)) {
    void Promise.resolve(
      hintChannel.send({
        type: 'broadcast',
        event: HINT_EVENT,
        payload: { app: HINT_APP, table, at, device: DEVICE_ID },
      })
    ).catch(() => {
      /* a lost hint costs only latency */
    });
  }
}

export function stopRealtime(): void {
  const session = live;
  live = null;
  setPushAnnouncer(null);
  if (session) {
    session.detach();
    if (session.retryTimer) clearTimeout(session.retryTimer);
    if (session.hintTimer) clearTimeout(session.hintTimer);
    session.hintBatch.cancel();
  }
  if (channel) {
    void supabase.removeChannel(channel);
    channel = null;
  }
  if (hintChannel) {
    void supabase.removeChannel(hintChannel);
    hintChannel = null;
  }
  setRealtimeState('off');
  if (pullTimer) {
    clearTimeout(pullTimer);
    pullTimer = null;
  }
}
