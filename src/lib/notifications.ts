// ─── Unified notification service ───────────────────────────────────────
//
// Single entry point for every notification the app schedules. Wraps our
// custom NexusNotifications Capacitor plugin (defined in
// android/app/src/main/java/com/limecore/nexus/NexusNotificationsPlugin.java)
// with:
//
//   • Native-platform guard (web dev calls become no-ops without crashing)
//   • Per-category Android notification channels so the user can mute one
//     category (e.g. "Budget alerts") from system settings without nuking
//     the rest
//   • A stable ID range allocator so each category owns a disjoint slice
//     of the int-32 ID space — re-scheduling and cancellation work without
//     having to track IDs across modules
//   • A single permission check that every category routes through
//
// All notifications fire on-device via AlarmManager + NotificationManager
// (in our own native plugin). No FCM, no Firebase, no Google Play
// Services — this is the F-Droid-clean path. The only OS-level requirement
// on Android 13+ is the runtime POST_NOTIFICATIONS permission, declared
// in AndroidManifest.xml.
//
// ─── ID allocation map ──────────────────────────────────────────────────
//   1000-1099  Reserved (legacy weekly-review used 1001)
//   2000-2999  Task due-date reminders (one ID per task, derived from task UUID)
//   3000-3099  Budget threshold alerts (one ID per category × threshold)
//   4000-4099  Portfolio end-of-day (4001 = 4:05pm primary, 4002 = 4:35pm backup)
//   5000-5999  News alerts (one ID per news item, derived from item ID)
//   6000-6099  Watchlist price targets (one ID per item × side, v1.15)
//   7000-7999  Insights tier changes (one ID per ticker, v1.2)
//   8000-11099 Habits (v1.2): 8000-8899 daily reminders (3 per slot),
//              8990-8998 milestones, 9000-11099 weekday reminders of a
//              specific-days habit (7 per slot, v1.18.1 NCC#168). See
//              habitReminders.ts.
// ────────────────────────────────────────────────────────────────────────

import { Capacitor } from '@capacitor/core';
import {
  NexusNotifications,
  type NotificationAction,
  type PendingActionResult,
  type PendingTapResult,
  type QueuedAction,
  type QueuedTap,
} from './nexusNotificationsPlugin';
import { useSettingsStore } from '../store/useSettingsStore';

export type { NotificationAction };

export type NotificationCategory =
  | 'weekly-review'
  | 'tasks'
  | 'budgets'
  | 'portfolio-eod'
  | 'news'
  | 'insights'
  | 'habits'
  | 'watchlist';

export interface NotificationResult {
  ok: boolean;
  reason?: string;
}

interface ChannelSpec {
  id: string;
  name: string;
  description: string;
  // Importance per Android NotificationManager constants:
  //   2 = LOW (silent, no peek)
  //   3 = DEFAULT (sound, no heads-up)
  //   4 = HIGH (heads-up popup)
  // News + EoD use LOW so we don't startle the user during work hours;
  // tasks + budgets get DEFAULT (they're action items). Weekly review is
  // a soft nudge so it also goes LOW.
  importance: 2 | 3 | 4;
}

const CHANNEL_SPECS: Record<NotificationCategory, ChannelSpec> = {
  'weekly-review': {
    id: 'weekly-review',
    name: 'Weekly Review',
    description: 'Sunday evening summary across finance, study, fitness, tasks',
    importance: 2,
  },
  tasks: {
    id: 'tasks',
    name: 'Task Reminders',
    description: 'Pings when a task is due',
    importance: 3,
  },
  budgets: {
    id: 'budgets',
    name: 'Budget Alerts',
    description: 'Heads-up when a category approaches or exceeds its monthly cap',
    importance: 3,
  },
  'portfolio-eod': {
    id: 'portfolio-eod',
    name: 'Portfolio End of Day',
    description: "Recap of today's move on US market close",
    importance: 2,
  },
  news: {
    id: 'news',
    name: 'Market News',
    description: 'Stories about tickers you own plus major market moves',
    importance: 2,
  },
  // v1.2 — Insights tier-change alerts. DEFAULT importance so the user notices
  // when a holding flips from Buy → Sell territory. 48h-per-ticker cooldown
  // prevents alert fatigue on volatile names.
  insights: {
    id: 'insights',
    name: 'Insights Tier Changes',
    description: 'Notifies when a holding crosses a Buy/Sell threshold',
    importance: 3,
  },
  // v1.2 — daily habit reminders. DEFAULT importance — surfaces in the tray
  // but doesn't peek, because we may schedule many of these per day and
  // peeking would be obnoxious. The user explicitly opts in per-habit by
  // setting a reminderTime; the absence of one means no notification.
  habits: {
    id: 'habits',
    name: 'Habit Reminders',
    description: 'Daily reminders for habits with a set time',
    importance: 3,
  },
  // v1.15 — a price the user named in advance has been reached. DEFAULT
  // importance like budgets: it is something they asked to act on, not news.
  watchlist: {
    id: 'watchlist',
    name: 'Watchlist Targets',
    description: 'When a watched ticker reaches a target price you set',
    importance: 3,
  },
};

// ID range bases — see "ID allocation map" comment above.
export const ID_RANGES: Record<NotificationCategory, { base: number; size: number }> = {
  'weekly-review': { base: 1000, size: 100 },
  tasks: { base: 2000, size: 1000 },
  budgets: { base: 3000, size: 100 },
  'portfolio-eod': { base: 4000, size: 100 },
  news: { base: 5000, size: 1000 },
  // v1.2 — one ID per ticker. Hash-derived (see ratingHistory.ts).
  insights: { base: 7000, size: 1000 },
  // v1.2 — one ID per habit. Hash-derived (see habitReminders.ts).
  // v1.18.1 (NCC#178): per-device assigned slots now, not the hash.
  // v1.18.1 (NCC#168): up to 11099, for one alarm per chosen weekday.
  habits: { base: 8000, size: 3100 },
  // v1.15 — 50 items × above/below. Hash-derived (see watchlistAlerts.ts).
  watchlist: { base: 6000, size: 100 },
};

// ─── Platform / availability ────────────────────────────────────────────

/** Returns true if we can actually schedule notifications on this platform.
 *  Always false on web (dev) — our native plugin isn't registered there.
 *  Wrapped in try/catch since the plugin object itself might throw on
 *  property access in some web environments. */
export async function notificationsAvailable(): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) return false;
  try {
    // A successful checkPermission round-trip is the only way to verify
    // the native plugin is actually registered and responsive. We don't
    // care about the result here — just that the call returned.
    await NexusNotifications.checkPermission();
    return true;
  } catch (e) {
    console.warn('[notifications] availability check failed:', (e as Error).message);
    return false;
  }
}

// ─── Permission ─────────────────────────────────────────────────────────

/** Idempotent — calling this when permission is already granted is a cheap
 *  no-op. On native it triggers the OS permission prompt if not yet granted
 *  (only on Android 13+; below that the manifest grant is automatic).
 *  Returns ok=false with a `reason` if the user denied or the platform
 *  doesn't support notifications. */
export async function ensureNotificationPermission(): Promise<NotificationResult> {
  if (!Capacitor.isNativePlatform()) {
    return { ok: false, reason: 'Notifications not available on this platform.' };
  }
  try {
    const check = await NexusNotifications.checkPermission();
    if (check.granted) return { ok: true };
    const req = await NexusNotifications.requestPermission();
    if (req.granted) return { ok: true };
    return { ok: false, reason: 'Notification permission denied.' };
  } catch (e) {
    return { ok: false, reason: (e as Error).message || String(e) };
  }
}

/** Returns true if permission has *already* been granted, without prompting.
 *  Used by per-feature schedulers to early-out when the user has the master
 *  notif toggle on but the OS-level permission was revoked from system
 *  settings since the last app session. Falls back to false on any error
 *  rather than blocking; the caller treats that as "not granted, prompt
 *  the user". */
export async function hasNotificationPermission(): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) return false;
  try {
    const check = await NexusNotifications.checkPermission();
    return check.granted;
  } catch (e) {
    console.warn('[notifications] hasNotificationPermission:', (e as Error).message);
    return false;
  }
}

// ─── Channels ───────────────────────────────────────────────────────────

const createdChannels = new Set<NotificationCategory>();

/** Create the Android notification channel for a category if not yet
 *  created in this session. Idempotent and best-effort — failures are
 *  logged. Pre-Oreo Androids ignore channels entirely (no-op on the
 *  native side) so this is safe to call there. */
async function ensureChannel(category: NotificationCategory): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  if (createdChannels.has(category)) return;
  const spec = CHANNEL_SPECS[category];
  try {
    await NexusNotifications.createChannel({
      id: spec.id,
      name: spec.name,
      description: spec.description,
      importance: spec.importance,
    });
    createdChannels.add(category);
  } catch (e) {
    console.warn('[notifications] ensureChannel', category, (e as Error).message);
  }
}

// ─── Schedule / cancel ──────────────────────────────────────────────────

interface ScheduleOptions {
  /** Stable numeric ID within the category's range. Re-scheduling with the
   *  same ID overwrites the prior notification. */
  id: number;
  category: NotificationCategory;
  title: string;
  body: string;
  /** When to fire. Omit for "immediately" (1 second from now — the native
   *  side won't accept past times, it floors them). */
  at?: Date;
  /** Repeat cadence. v1.18.1 (NCC#138): 'day' is honoured by the native
   *  plugin, which re-arms the alarm for the same local time the next day
   *  each time it fires. v1.18.1 (NCC#168): 'week' too, but only with
   *  `weeklyTime`. Other values are not honoured and are not sent; nor is
   *  'week' without `weeklyTime`: the Weekly Review flow re-arms itself on
   *  every app start. */
  every?: 'day' | 'week' | 'month' | 'year';
  /** v1.18.1 (NCC#138): with every: 'day', the wall-clock time it repeats at.
   *  Pass it when you have it: `at` cannot show it on a day when that time
   *  falls in a skipped DST hour, and the native side would otherwise read it
   *  off `at`. */
  dailyTime?: { hour: number; minute: number };
  /** v1.18.1 (NCC#168): with every: 'week', the weekday (0 = Sunday, as
   *  Date.getDay()) and wall-clock time it repeats at. */
  weeklyTime?: { weekday: number; hour: number; minute: number };
  /** Arbitrary payload — read in the tap handler. Keep small; this rides
   *  the AlarmManager intent. The `route` field is special: if present,
   *  the tap handler navigates there. */
  extra?: Record<string, unknown> & { route?: string };
  /** Optional inline action buttons (1-3 recommended; Android collapses
   *  extras into an overflow). Each action's `id` is compared in the
   *  `onNotificationAction` handler; the action's `extra` payload arrives
   *  as a JSON-encoded string on the event. */
  actions?: NotificationAction[];
}

/** v1.18.1 (NCC#151): the master switch, read from LOADED settings. Until
 *  useSettingsStore.load() resolves the switch holds its default, off, and
 *  habits load beside settings on a cold start (AppShell) and before them
 *  behind the lock screen (App's cloud hydration), so every reminder they
 *  re-armed was refused. load() shares one read between concurrent callers. */
async function masterSwitchOn(): Promise<boolean> {
  const settings = useSettingsStore.getState();
  if (!settings.loaded) {
    try {
      await settings.load();
    } catch (e) {
      console.warn('[notifications] settings load', (e as Error).message);
      return false;
    }
  }
  return useSettingsStore.getState().notifMasterEnabled;
}

/** Schedule (or overwrite) a notification. Verifies the ID falls in the
 *  category's allocated range — passing an out-of-range ID throws so we
 *  catch range collisions in dev rather than have notifications stomp on
 *  each other in prod. */
export async function scheduleNotification(opts: ScheduleOptions): Promise<NotificationResult> {
  // v1.18.1 (NCC#186) — taken before the first await; see reminderGate.
  const epoch = cancelAllEpoch;
  const range = ID_RANGES[opts.category];
  if (opts.id < range.base || opts.id >= range.base + range.size) {
    throw new Error(
      `Notification ID ${opts.id} out of range for category "${opts.category}" ` +
        `(expected ${range.base}..${range.base + range.size - 1})`,
    );
  }
  if (!Capacitor.isNativePlatform()) {
    return { ok: false, reason: 'Notifications not available on this platform.' };
  }
  // v1.18.1 (NCC#151): the master switch, checked here so no scheduler can
  // miss it. Habit reminders, habit milestones and insights tier alerts never
  // checked it, so they kept firing for users who had turned notifications off.
  if (!(await masterSwitchOn())) {
    return { ok: false, reason: 'Notifications are turned off.' };
  }
  if (!(await hasNotificationPermission())) {
    return { ok: false, reason: 'Notification permission not granted.' };
  }
  await ensureChannel(opts.category);
  const atMillis = opts.at ? opts.at.getTime() : Date.now() + 1000;
  // v1.18.1 (NCC#186) — the last check before the native call. Everything
  // that schedules (task/habit re-arms, the EoD/news/watchlist ticks, budget
  // and insight alerts) comes through here, and its awaits above can resolve
  // after a sign-out's cancelAllReminders. An involuntary sign-out does not
  // reload, so without this a refresh still in flight could arm the previous
  // account's recap or post its news on the Login screen.
  const refused = reminderGate(epoch);
  if (refused) {
    console.warn('[notifications] not scheduled:', opts.category, opts.id, refused);
    return { ok: false, reason: refused };
  }
  try {
    await NexusNotifications.schedule({
      id: opts.id,
      title: opts.title,
      body: opts.body,
      channelId: CHANNEL_SPECS[opts.category].id,
      atMillis,
      extra: opts.extra,
      actions: opts.actions,
      ...(opts.every === 'day' ? { every: 'day', ...opts.dailyTime } : {}),
      ...(opts.every === 'week' && opts.weeklyTime ? { every: 'week', ...opts.weeklyTime } : {}),
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}

/** Cancel one or more notifications by ID. Safe to call with IDs that were
 *  never scheduled — the native side silently ignores misses. v1.18.1
 *  (NCC#178): false when the plugin call failed. */
export async function cancelNotifications(ids: number[]): Promise<boolean> {
  if (ids.length === 0 || !Capacitor.isNativePlatform()) return true;
  try {
    await NexusNotifications.cancel({ ids });
    return true;
  } catch (e) {
    console.warn('[notifications] cancel', (e as Error).message);
    return false;
  }
}

/** The plugin's tracked IDs that fall in a category's range. Tracked means
 *  scheduled and not cancelled since: an alarm that already fired stays on
 *  the list. Empty off native; v1.18.1 (NCC#178): null on error. */
export async function pendingIdsIn(category: NotificationCategory): Promise<number[] | null> {
  if (!Capacitor.isNativePlatform()) return [];
  const range = ID_RANGES[category];
  try {
    const pending = await NexusNotifications.getPending();
    return pending.ids.filter((id) => id >= range.base && id < range.base + range.size);
  } catch (e) {
    console.warn('[notifications] getPending', category, (e as Error).message);
    return null;
  }
}

/** Cancel every pending notification in a category by enumerating the
 *  plugin's tracked-ID list and filtering by ID range. Used by the master
 *  Settings toggle and per-category off-switches. */
export async function cancelCategory(category: NotificationCategory): Promise<void> {
  await cancelNotifications((await pendingIdsIn(category)) ?? []);
}

// v1.18.1 (NCC#186) — how long cancelAllReminders waits for the plugin. Its
// two calls answer in milliseconds; the cap is there so a wedged bridge can
// never hold up a sign-out or a wipe.
export const CANCEL_ALL_WAIT_MS = 3000;

let cancelAllEpoch = 0;

// v1.18.1 (NCC#186) — who the reminders are for. Registered by
// useSessionStore (a signed-in user, or guest mode); this module cannot import
// it without a cycle. Unregistered (unit tests of this module alone) means yes.
let hasAudience: () => boolean = () => true;

/** v1.18.1 (NCC#186) — see hasAudience. */
export function setReminderAudience(check: () => boolean): void {
  hasAudience = check;
}

/** v1.18.1 (NCC#186) — why a schedule that began at `epoch` must not reach the
 *  plugin, or null when it may: everything was cancelled since it began
 *  (sign-out, wipe, master switch off), or nobody is signed in and the app is
 *  not in guest mode. */
function reminderGate(epoch: number): string | null {
  if (epoch !== cancelAllEpoch) return 'Reminders were cancelled while this one was being scheduled.';
  let present: boolean;
  try {
    present = hasAudience();
  } catch {
    present = true;
  }
  return present ? null : 'Nobody is signed in.';
}

/** v1.18.1 (NCC#186) — bumped by every cancelAllReminders call, so code that
 *  remembers "these reminders are already armed" (reconcileTaskRemindersIfChanged)
 *  knows that memory is stale. */
export function reminderEpoch(): number {
  return cancelAllEpoch;
}

/** v1.18.1 (NCC#186) — cancel every reminder NCC has scheduled, of every
 *  category, and remove any already posted. One getPending and one cancel.
 *
 *  Why every tracked ID rather than a list of categories: every ID the plugin
 *  tracks was scheduled through scheduleNotification, which only accepts IDs
 *  inside ID_RANGES. Taking them all means a category added later is covered
 *  without anyone editing a list (the Settings master switch used to name six
 *  of the eight categories and missed habits and insights). The plugin has no
 *  cancelAll of its own (NexusNotificationsPlugin.java has cancel/getPending).
 *
 *  Used by sign-out, by the involuntary SIGNED_OUT, by clearAllLocalData and by
 *  the master switch. Never throws and never waits longer than
 *  CANCEL_ALL_WAIT_MS: a failure is logged and the caller carries on.
 *  Resolves true when the plugin confirmed the cancel (or there was nothing
 *  to cancel, or the platform has no notifications). */
export async function cancelAllReminders(): Promise<boolean> {
  cancelAllEpoch++;
  const work = (async () => {
    if (!Capacitor.isNativePlatform()) return true;
    const pending = await NexusNotifications.getPending();
    const ids = pending.ids;
    if (ids.length) await NexusNotifications.cancel({ ids });
    return true;
  })().catch((e: unknown) => {
    // Caught here, not around the race, so a failure that lands after the
    // timeout is still logged rather than left as an unhandled rejection.
    console.warn('[notifications] cancelAllReminders', (e as Error)?.message ?? String(e));
    return false;
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<boolean>((res) => {
        timer = setTimeout(() => {
          console.warn('[notifications] cancelAllReminders timed out');
          res(false);
        }, CANCEL_ALL_WAIT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// ─── Tap routing ────────────────────────────────────────────────────────

/** v1.16 (limecore#36) — a route is followed only if it is a plain path
 *  inside this app: one leading `/`, then no second slash or backslash right
 *  after it, no backslash anywhere, and no control characters.
 *
 *  Why: MainActivity is exported (it is the launcher), and it reads the tap
 *  route off ANY intent that starts it, so any installed app could launch
 *  NCC onto a route of its choosing. Every route NCC schedules itself is a
 *  literal like `/finance/budgets`, which this accepts. What it refuses —
 *  `//host`, `/\host`, `\\host`, `https://…` — are the shapes of the
 *  React Router open redirect GHSA-wrjc-x8rr-h8h6, fixed only in RR 7. */
export function isAppRoute(route: unknown): route is string {
  return (
    typeof route === 'string' &&
    route.length <= 512 &&
    /^\/(?![/\\])/.test(route) &&
    !route.includes('\\') &&
    // eslint-disable-next-line no-control-regex -- matching control characters is the point
    !/[\u0000-\u001f\u007f]/.test(route)
  );
}

// ─── Queued taps and actions (v1.18.1, NCC#169) ────────────────────────
//
// The native side queues every tap and action (persisted, oldest first,
// each with a `seq`) and sends it live as well. An entry stays queued until
// JS acknowledges it, so an action taken while NCC was closed survives the
// process being killed before NCC is opened, and two of them are both kept.
// The same entry can therefore reach JS more than once: live and then in a
// drain, or in two drains (a re-subscription, or an ack that has not landed
// yet). These make each seq count once per JS lifetime.

const appliedTapSeqs = new Set<number>();
/** Actions by seq: being applied (the path applying it acknowledges it once
 *  done) or handled (applied, or skipped by a drain; safe to acknowledge). */
const actionSeqState = new Map<number, 'applying' | 'handled'>();

/** A queued tap older than this is acknowledged but not followed: it is from
 *  a launch whose process died before JS read it, and navigating there on a
 *  later, unrelated open would be a surprise. The same goes for a queued
 *  action other than 'done' (they navigate, e.g. 'view'). */
export const TAP_MAX_AGE_MS = 10 * 60_000;

/** A queued 'done' older than this is acknowledged but not applied. It
 *  outlives a closed app for days on purpose; the cap is for a replay after a
 *  crash or a lost ack, which must not complete a task reopened since. */
export const DONE_ACTION_MAX_AGE_MS = 7 * 86_400_000;

/** Queued within `maxAge` of `now`. An entry without a time (the pre-NCC#169
 *  single slot) counts as fresh. */
function isFresh(item: { at?: unknown }, maxAge: number, now: number): boolean {
  return typeof item.at !== 'number' || now - item.at <= maxAge;
}

function hasSeq(item: { seq?: unknown }): item is { seq: number } {
  return typeof item.seq === 'number' && Number.isInteger(item.seq) && item.seq >= 0;
}

/** True the first time a seq is seen, and records it. An entry without one
 *  (the native side could not queue it) cannot be told apart, so it counts. */
function firstTime(applied: Set<number>, item: { seq?: unknown }): boolean {
  if (!hasSeq(item)) return true;
  if (applied.has(item.seq)) return false;
  applied.add(item.seq);
  return true;
}

function seqsOf(items: { seq?: unknown }[]): number[] {
  return items.filter(hasSeq).map((i) => i.seq);
}

/** The queue from a consumePendingTap result, oldest first. A result without
 *  `taps` is the pre-NCC#169 single slot. */
export function queuedTaps(r: PendingTapResult | null | undefined): QueuedTap[] {
  if (!r) return [];
  if (Array.isArray(r.taps)) return r.taps;
  return r.route ? [{ seq: -1, route: r.route }] : [];
}

/** The queue from a consumePendingAction result, oldest first; as queuedTaps. */
export function queuedActions(r: PendingActionResult | null | undefined): QueuedAction[] {
  if (!r) return [];
  if (Array.isArray(r.actions)) return r.actions;
  return r.actionId ? [{ seq: -1, actionId: r.actionId, route: r.route, extraJson: r.extraJson }] : [];
}

async function ackTaps(items: { seq?: unknown }[]): Promise<void> {
  const seqs = seqsOf(items);
  if (seqs.length === 0) return;
  try {
    await NexusNotifications.ackPendingTaps({ seqs });
  } catch (e) {
    console.warn('[notifications] ackPendingTaps failed:', (e as Error).message);
  }
}

async function ackActions(items: { seq?: unknown }[]): Promise<void> {
  const seqs = seqsOf(items);
  if (seqs.length === 0) return;
  try {
    await NexusNotifications.ackPendingActions({ seqs });
  } catch (e) {
    console.warn('[notifications] ackPendingActions failed:', (e as Error).message);
  }
}

/** Subscribe to notification taps. Calls `onOpen(route)` with the route
 *  encoded in the notification's `extra.route` payload. Returns an
 *  unsubscriber. Safe to call on web — returns a no-op unsubscriber.
 *
 *  Notifications without a `route` payload are silently dropped — the user
 *  tapping a "Budget exceeded" alert with no route attached just opens the
 *  app to its last-visible screen, which is the correct default. */
export async function onNotificationTap(
  onOpen: (route: string) => void,
): Promise<() => void> {
  if (!Capacitor.isNativePlatform()) return () => {};
  try {
    const handle = await NexusNotifications.addListener('notificationTap', (event) => {
      if (firstTime(appliedTapSeqs, event) && isAppRoute(event.route)) onOpen(event.route);
      // v1.18.1 (NCC#143): the native side also queues every tap for the
      // cold-start drain below. This one was delivered live, so acknowledge
      // it, or the next subscription would replay it. v1.18.1 (NCC#169): by
      // its seq, so the rest of the queue stays.
      void ackTaps([event]);
    });
    // v1.3.1 BUG-14 — drain the cold-start queue. If the app was launched
    // from a notification tap, the native event already fired (before this
    // listener was registered) and the route was queued. Pull it now so
    // the navigation lands. Warm-start taps arrive via the listener above;
    // the queue is then empty so this is a cheap no-op.
    try {
      const taps = queuedTaps(await NexusNotifications.consumePendingTap());
      // v1.18.1 (NCC#169): only the newest fresh tap is followed; stepping
      // through older ones would only fill the back stack.
      const now = Date.now();
      let target: string | null = null;
      for (const tap of taps) {
        if (!firstTime(appliedTapSeqs, tap)) continue;
        if (isFresh(tap, TAP_MAX_AGE_MS, now) && isAppRoute(tap.route)) target = tap.route;
      }
      if (target) onOpen(target);
      await ackTaps(taps);
    } catch (e) {
      console.warn('[notifications] consumePendingTap failed:', (e as Error).message);
    }
    return () => {
      handle.remove();
    };
  } catch (e) {
    console.warn('[notifications] onNotificationTap', (e as Error).message);
    return () => {};
  }
}

/** Payload delivered to the action-tap handler. `extra` is the parsed
 *  JSON of whatever was set on the action's `extra` field at schedule
 *  time; null if the schedule call didn't include one or parsing failed. */
interface NotificationActionPayload {
  actionId: string;
  route: string;
  extra: Record<string, unknown> | null;
}

/** May return a promise (v1.18.1, NCC#169): it is awaited before the next
 *  queued action. Any other return value is ignored. */
type NotificationActionHandler = (payload: NotificationActionPayload) => unknown;

/** Hands one action to the handler and waits for it. A handler that throws
 *  is logged, not retried: the action is still acknowledged, or it would
 *  fail again on every launch. */
async function applyAction(
  handler: NotificationActionHandler,
  item: { actionId: string; route: string; extraJson: string },
): Promise<void> {
  let extra: Record<string, unknown> | null = null;
  if (item.extraJson) {
    try {
      extra = JSON.parse(item.extraJson);
    } catch {
      // Malformed JSON shouldn't break the handler. Just leave extra null.
    }
  }
  try {
    await handler({ actionId: item.actionId, route: isAppRoute(item.route) ? item.route : '', extra });
  } catch (e) {
    console.warn('[notifications] action handler failed:', item.actionId, (e as Error).message);
  }
}

/** Subscribe to action-button taps (NOT the notification body itself —
 *  that's `onNotificationTap`). Handler receives the actionId, the
 *  optional route, and the parsed extra payload. The notification is
 *  auto-dismissed on the native side before the event reaches JS, so
 *  the handler doesn't need to clear it.
 *
 *  v1.18.1 (NCC#169): each queued action is handed over once, oldest
 *  first, each awaited before the next when the handler returns a promise,
 *  and acknowledged (removed from the native queue) only after that. A
 *  drain applies every 'done' younger than DONE_ACTION_MAX_AGE_MS, and of
 *  the other actions, which navigate, only the newest one younger than
 *  TAP_MAX_AGE_MS. A live action is always applied. */
export async function onNotificationAction(handler: NotificationActionHandler): Promise<() => void> {
  if (!Capacitor.isNativePlatform()) return () => {};
  try {
    const sub = await NexusNotifications.addListener('notificationAction', (event) => {
      void (async () => {
        if (!hasSeq(event)) {
          await applyAction(handler, event);
          return;
        }
        const state = actionSeqState.get(event.seq);
        if (state === 'applying') return; // the drain applying it acknowledges it
        if (!state) {
          actionSeqState.set(event.seq, 'applying');
          await applyAction(handler, event);
          actionSeqState.set(event.seq, 'handled');
        }
        // v1.18.1 (NCC#143): delivered live, so acknowledge it; left queued,
        // the next subscription replayed it and a "Mark done" flipped the
        // task back to not done. v1.18.1 (NCC#169): by its seq, after the
        // handler has run.
        await ackActions([event]);
      })();
    });
    // v1.3.1 BUG-14 — drain the cold-start action queue (same rationale as
    // onNotificationTap's drain). Cold-start from a "Mark done" tap would
    // otherwise leave the task untoggled because the JS handler missed the
    // event window.
    try {
      const actions = queuedActions(await NexusNotifications.consumePendingAction());
      const now = Date.now();
      const unseen = (a: QueuedAction) => !hasSeq(a) || !actionSeqState.has(a.seq);
      // The newest fresh navigation; following older ones too would only
      // chain screens and fill the back stack.
      let navigation: QueuedAction | null = null;
      for (const a of actions) {
        if (a.actionId !== 'done' && unseen(a) && isFresh(a, TAP_MAX_AGE_MS, now)) navigation = a;
      }
      // Acknowledged: what this drain applied or skipped, and what was
      // handled before. Not what the live path is still applying; it
      // acknowledges that itself when done.
      const taken: QueuedAction[] = [];
      for (const a of actions) {
        if (!unseen(a)) {
          if (actionSeqState.get(a.seq) === 'handled') taken.push(a);
          continue;
        }
        const due = a.actionId === 'done' ? isFresh(a, DONE_ACTION_MAX_AGE_MS, now) : a === navigation;
        if (hasSeq(a)) actionSeqState.set(a.seq, 'applying');
        if (due) await applyAction(handler, a);
        if (hasSeq(a)) actionSeqState.set(a.seq, 'handled');
        taken.push(a);
      }
      await ackActions(taken);
    } catch (e) {
      console.warn('[notifications] consumePendingAction failed:', (e as Error).message);
    }
    return () => {
      sub.remove();
    };
  } catch (e) {
    console.warn('[notifications] onNotificationAction', (e as Error).message);
    return () => {};
  }
}
