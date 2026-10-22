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
import { useFinanceStore } from '../store/useFinanceStore';
import { useStudiesStore } from '../store/useStudiesStore';
import { useFitnessStore } from '../store/useFitnessStore';
import { useTaskStore } from '../store/useTaskStore';
import type { WorkoutSession } from '../types/fitness';
import { localDateKey } from '@/utils/formatters';

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
 * Build the notification body as a snapshot of the past 7 days across the
 * four life-domain stores. Each segment only appears if there's actual
 * movement to report — an empty week falls back to the generic prompt.
 *
 * **Snapshot timing:** body is computed at scheduling time (every app
 * launch), not at fire time. The native plugin doesn't support callback-at-
 * fire-time, so what the user sees Sunday 18:00 is whatever was true at
 * their last app open. Since most users open the app daily, this is
 * acceptable; the worst case is a notification body that's a few days
 * stale from when it fires.
 *
 * **Currency:** raw sum of transaction amounts assuming a single base
 * currency. Mixed-currency users will see a slightly off total in the
 * notification preview; tapping into /review shows the FX-converted truth.
 */
function buildWeeklySummaryBody(): string {
  const now = new Date();
  const weekAgo = new Date(now);
  weekAgo.setDate(weekAgo.getDate() - 7);
  // v1.18.1 (NCC#145): local calendar dates, as the stored dates are.
  const weekAgoIso = localDateKey(weekAgo);
  const todayIso = localDateKey(now);
  const parts: string[] = [];

  // ── Finance: 7-day net (income − expenses) ────────────────────────
  try {
    const txns = useFinanceStore.getState().transactions;
    const baseCurrency = useSettingsStore.getState().baseCurrency ?? 'EUR';
    const symbol = baseCurrency === 'USD' ? '$' : baseCurrency === 'EUR' ? '€' : baseCurrency + ' ';
    let net = 0;
    for (const t of txns) {
      if (!t.date || t.date < weekAgoIso) continue;
      if (t.type === 'income') net += t.amount;
      else if (t.type === 'expense') net -= t.amount;
    }
    if (Math.abs(net) >= 1) {
      const sign = net >= 0 ? '+' : '−';
      parts.push(`${sign}${symbol}${Math.abs(Math.round(net))} net`);
    }
  } catch (_) { /* finance store unavailable — skip */ }

  // ── Studies: GPA + delta vs previous import ───────────────────────
  try {
    const studies = useStudiesStore.getState();
    const gpa = studies.currentImport?.calculatedGpa;
    if (gpa != null && gpa > 0) {
      const prev = studies.previousGpa;
      if (prev != null && Math.abs(gpa - prev) >= 0.005) {
        const delta = gpa - prev;
        const sign = delta >= 0 ? '+' : '−';
        parts.push(`GPA ${gpa.toFixed(2)} (${sign}${Math.abs(delta).toFixed(2)})`);
      } else {
        parts.push(`GPA ${gpa.toFixed(2)}`);
      }
    }
  } catch (_) { /* studies store unavailable — skip */ }

  // ── Fitness: session count in past 7 days ─────────────────────────
  try {
    // useFitnessStore exposes `sessions` (not `workoutSessions`); each is
    // a WorkoutSession enriched with its sets array. We only need the
    // date filter, so destructure to the bare type.
    const sessions = useFitnessStore.getState().sessions as WorkoutSession[];
    const count = sessions.filter((s) => s.date && s.date >= weekAgoIso).length;
    if (count > 0) parts.push(`${count} workout${count === 1 ? '' : 's'}`);
  } catch (_) { /* fitness store unavailable — skip */ }

  // ── Tasks: overdue (dueDate < today, !completed) ──────────────────
  try {
    const tasks = useTaskStore.getState().tasks;
    const overdue = tasks.filter(
      (t) => !t.completed && t.dueDate && t.dueDate < todayIso,
    ).length;
    if (overdue > 0) parts.push(`${overdue} overdue task${overdue === 1 ? '' : 's'}`);
  } catch (_) { /* task store unavailable — skip */ }

  if (parts.length === 0) {
    return 'Tap to review your week — finance, study, fitness, tasks.';
  }
  const joined = parts.join(' · ');
  // ~80 char ceiling for notification body before truncation
  return joined.length > 80 ? joined.slice(0, 77) + '…' : joined;
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
    title: 'Your week is ready',
    body: buildWeeklySummaryBody(),
    at: nextSundayAt(18, 0),
    every: 'week',
    extra: { route: '/review' },
  });
}

export async function cancelWeeklyReview(): Promise<void> {
  await cancelNotifications([NOTIFICATION_ID]);
}

export const onNotificationTap = onNotificationTapInternal;
