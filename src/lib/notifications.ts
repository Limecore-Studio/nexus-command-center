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
// ────────────────────────────────────────────────────────────────────────

import { Capacitor } from '@capacitor/core';
import { NexusNotifications, type NotificationAction } from './nexusNotificationsPlugin';
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
  habits: { base: 8000, size: 1000 },
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
   *  each time it fires. Other values are not, and are not sent: the Weekly
   *  Review flow re-arms itself on every app start. */
  every?: 'day' | 'week' | 'month' | 'year';
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

/** Schedule (or overwrite) a notification. Verifies the ID falls in the
 *  category's allocated range — passing an out-of-range ID throws so we
 *  catch range collisions in dev rather than have notifications stomp on
 *  each other in prod. */
export async function scheduleNotification(opts: ScheduleOptions): Promise<NotificationResult> {
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
  if (!useSettingsStore.getState().notifMasterEnabled) {
    return { ok: false, reason: 'Notifications are turned off.' };
  }
  if (!(await hasNotificationPermission())) {
    return { ok: false, reason: 'Notification permission not granted.' };
  }
  await ensureChannel(opts.category);
  const atMillis = opts.at ? opts.at.getTime() : Date.now() + 1000;
  try {
    await NexusNotifications.schedule({
      id: opts.id,
      title: opts.title,
      body: opts.body,
      channelId: CHANNEL_SPECS[opts.category].id,
      atMillis,
      extra: opts.extra,
      actions: opts.actions,
      ...(opts.every === 'day' ? { every: 'day' } : {}),
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}

/** Cancel one or more notifications by ID. Safe to call with IDs that were
 *  never scheduled — the native side silently ignores misses. */
export async function cancelNotifications(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  if (!Capacitor.isNativePlatform()) return;
  try {
    await NexusNotifications.cancel({ ids });
  } catch (e) {
    console.warn('[notifications] cancel', (e as Error).message);
  }
}

/** Cancel every pending notification in a category by enumerating the
 *  plugin's tracked-ID list and filtering by ID range. Used by the master
 *  Settings toggle and per-category off-switches. */
export async function cancelCategory(category: NotificationCategory): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  const range = ID_RANGES[category];
  try {
    const pending = await NexusNotifications.getPending();
    const ids = pending.ids.filter(
      (id) => id >= range.base && id < range.base + range.size,
    );
    if (ids.length) await NexusNotifications.cancel({ ids });
  } catch (e) {
    console.warn('[notifications] cancelCategory', category, (e as Error).message);
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
      if (isAppRoute(event.route)) onOpen(event.route);
      // v1.18.1 (NCC#143): the native side also buffers every tap for the
      // cold-start drain below. This one was delivered live, so clear the
      // buffer, or the next subscription would replay it.
      void NexusNotifications.consumePendingTap().catch(() => {});
    });
    // v1.3.1 BUG-14 — drain the cold-start buffer. If the app was launched
    // from a notification tap, the native event already fired (before this
    // listener was registered) and the route was buffered. Pull it now so
    // the navigation lands. Warm-start taps arrive via the listener above;
    // the buffer is then empty so this is a cheap no-op.
    try {
      const pending = await NexusNotifications.consumePendingTap();
      if (isAppRoute(pending.route)) onOpen(pending.route);
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

/** Subscribe to action-button taps (NOT the notification body itself —
 *  that's `onNotificationTap`). Handler receives the actionId, the
 *  optional route, and the parsed extra payload. The notification is
 *  auto-dismissed on the native side before the event reaches JS, so
 *  the handler doesn't need to clear it. */
export async function onNotificationAction(
  handler: (payload: NotificationActionPayload) => void,
): Promise<() => void> {
  if (!Capacitor.isNativePlatform()) return () => {};
  try {
    const sub = await NexusNotifications.addListener('notificationAction', (event) => {
      let extra: Record<string, unknown> | null = null;
      if (event.extraJson) {
        try {
          extra = JSON.parse(event.extraJson);
        } catch {
          // Malformed JSON shouldn't break the handler. Just leave extra null.
        }
      }
      handler({ actionId: event.actionId, route: isAppRoute(event.route) ? event.route : '', extra });
      // v1.18.1 (NCC#143): delivered live, so clear the native buffer; left
      // there, the next subscription replayed it and a "Mark done" flipped
      // the task back to not done.
      void NexusNotifications.consumePendingAction().catch(() => {});
    });
    // v1.3.1 BUG-14 — drain the cold-start action buffer (same rationale as
    // onNotificationTap's drain). Cold-start from a "Mark done" tap would
    // otherwise leave the task untoggled because the JS handler missed the
    // event window.
    try {
      const pending = await NexusNotifications.consumePendingAction();
      if (pending.actionId) {
        let extra: Record<string, unknown> | null = null;
        if (pending.extraJson) {
          try {
            extra = JSON.parse(pending.extraJson);
          } catch {
            // Malformed JSON shouldn't break the drain — handler gets null.
          }
        }
        handler({ actionId: pending.actionId, route: isAppRoute(pending.route) ? pending.route : '', extra });
      }
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
