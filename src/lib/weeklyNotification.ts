// Sunday 18:00 local push reminder for the Weekly Review.
//
// This module used to own the entire LocalNotifications integration (plugin
// loader, permission flow, channel creation, tap routing). All of that is
// now in src/lib/notifications.ts — a unified service shared by every
// notification category (tasks, budgets, portfolio EoD, news, weekly review).
//
// What's left here is just the *scheduling logic* specific to the weekly
// review: pick "next Sunday at 18:00", encode the /review route, schedule
// with a stable ID in the weekly-review range. Existing callers (App.tsx +
// Settings.tsx) keep their imports intact — the public API surface didn't
// change shape.

import {
  ID_RANGES,
  cancelNotifications,
  ensureNotificationPermission,
  notificationsAvailable as notificationsAvailableInternal,
  onNotificationTap as onNotificationTapInternal,
  scheduleNotification,
  type NotificationResult,
} from './notifications';
import { useSettingsStore } from '../store/useSettingsStore';
import i18n from '../i18n';

// First slot in the weekly-review ID range. Re-scheduling with the same ID
// overwrites the prior one so we don't accumulate orphan alarms across
// app restarts.
const NOTIFICATION_ID = ID_RANGES['weekly-review'].base + 1; // 1001

export type { NotificationResult } from './notifications';

export async function notificationsAvailable(): Promise<boolean> {
  return notificationsAvailableInternal();
}

/** Re-export the unified permission flow under the original name so the
 *  Settings.tsx import doesn't have to change. */
export async function requestNotificationPermission(): Promise<NotificationResult> {
  return ensureNotificationPermission();
}

/** Returns the next Sunday at the given hour in local time. If today is
 *  Sunday and the time hasn't passed yet, today qualifies. */
function nextSundayAt(hour: number, minute: number = 0): Date {
  const now = new Date();
  const target = new Date(now);
  target.setHours(hour, minute, 0, 0);
  // Sun=0, Mon=1, …, Sat=6. Days until next Sunday inclusive of today
  // (if time hasn't passed).
  const daysAhead = (7 - now.getDay()) % 7;
  if (daysAhead === 0 && target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 7);
  } else {
    target.setDate(target.getDate() + daysAhead);
  }
  return target;
}

/**
 * Schedule the Sunday 18:00 reminder. Overwrites any existing schedule
 * with the same ID. Returns ok=false if the platform doesn't support it
 * or permission is denied. Caller is responsible for storing the user's
 * preference; this function only touches the schedule.
 */
export async function scheduleWeeklyReview(): Promise<NotificationResult> {
  // Master kill-switch check. Schedule from the NotificationBridge fires on
  // every app start as long as `weeklyReminder` is true — if the user has
  // since flipped the master toggle off, we don't want to silently re-arm.
  if (!useSettingsStore.getState().notifMasterEnabled) {
    return { ok: false, reason: 'Notifications are turned off in Settings.' };
  }
  return scheduleNotification({
    id: NOTIFICATION_ID,
    category: 'weekly-review',
    // v1.22 (NCC#263): one short, translated text, repeated by the OS every
    // Sunday. The old body was a stats snapshot built when the app opened
    // (often before the task store had loaded, and up to six days stale by
    // Sunday), in English only, and the reminder was a one-shot re-armed
    // only on app start, so a week without opening NCC had no reminder at
    // all: the user it was for. The numbers are on the Review screen.
    title: i18n.t('notif.weekly.title'),
    body: i18n.t('notif.weekly.body'),
    at: nextSundayAt(18, 0),
    every: 'week',
    weeklyTime: { weekday: 0, hour: 18, minute: 0 },
    extra: { route: '/review' },
  });
}

export async function cancelWeeklyReview(): Promise<void> {
  await cancelNotifications([NOTIFICATION_ID]);
}

export const onNotificationTap = onNotificationTapInternal;
