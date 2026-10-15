// Task due-date reminders.
//
// Schedules a local notification when a task is due: at its due time when
// `dueDate` carries one, at 09:00 local on the day when it is date-only.
// Cancels it when the task is completed, deleted, or has its due date cleared.
//
// Two forms of `dueDate`: a full ISO instant, which Add Task and Quick Log
// store from their date-and-time picker, fires at that instant (v1.18.1,
// NCC#142; it used to parse to NaN, so it never fired at all). A date-only
// YYYY-MM-DD has no time of day, and a notification fired at midnight is
// silly; 09:00 is a reasonable "start of working day" default.
//
// On app start (AppShell) we call `reconcileTaskReminders(tasks)`. That:
//   1. Cancels every pending notification in the tasks ID range. This
//      clears orphans for tasks that were deleted while the app was closed
//      (we don't track per-task notif IDs in storage; relying on stable
//      hash → notif ID would leak alarms for deleted task IDs).
//   2. Re-schedules a notification for every currently-incomplete task
//      with a future due date.
//
// ID mapping: stable hash from task UUID → slot in 2000-2999.
// Collisions are possible if you have >1000 active tasks; in practice the
// app's working set is far below that.

import type { Task } from '../types/tasks';
import { cancelCategory, cancelNotifications, ID_RANGES, scheduleNotification } from './notifications';
import { useSettingsStore } from '../store/useSettingsStore';
import { useTaskStore } from '../store/useTaskStore';

const TASKS_BASE = ID_RANGES.tasks.base;
const TASKS_SIZE = ID_RANGES.tasks.size;

function taskNotifId(taskId: string): number {
  let hash = 0;
  for (const ch of taskId) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return TASKS_BASE + (Math.abs(hash) % TASKS_SIZE);
}

/** When to remind about a task. A date-only dueDate ("YYYY-MM-DD") fires at
 *  09:00 local on that day. A dueDate with a time — what Add Task and Quick
 *  Log store, from a date-and-time picker — fires at that time.
 *  v1.18.1 (NCC#142): only the date-only form was understood, so the ISO
 *  instant the app itself stores parsed to NaN and no task reminder was ever
 *  scheduled. Returns null for an unreadable or past time (we'd rather skip
 *  than schedule something stale). */
export function dueAtNotifTime(dueDate: string, now: number = Date.now()): Date | null {
  let dt: Date;
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dueDate);
  if (dateOnly) {
    dt = new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]), 9, 0, 0, 0);
  } else {
    dt = new Date(dueDate);
  }
  if (Number.isNaN(dt.getTime()) || dt.getTime() <= now) return null;
  return dt;
}

/** Schedule a reminder for one task. No-ops if:
 *    • the tasks notification toggle is off
 *    • the task has no dueDate, is already completed, or its reminder time
 *      (see dueAtNotifTime) has already passed
 *  Idempotent — re-running for the same task overwrites the prior schedule.
 */
export async function scheduleTaskReminder(task: Task): Promise<void> {
  const settings = useSettingsStore.getState();
  if (!settings.notifMasterEnabled) return;
  if (!settings.notifTasksEnabled) return;
  if (task.completed) return;
  if (!task.dueDate) return;
  const at = dueAtNotifTime(task.dueDate);
  if (!at) return;
  // Build body: priority tag + optional first-line notes preview, trimmed
  // so the system doesn't truncate a long URL or paragraph.
  const priorityTag = task.priority === 'high' ? 'High priority · ' : '';
  const notesPreview = task.notes ? ' — ' + task.notes.split('\n')[0].slice(0, 80) : '';
  try {
    await scheduleNotification({
      id: taskNotifId(task.id),
      category: 'tasks',
      title: task.title,
      body: `${priorityTag}Due today${notesPreview}`,
      at,
      extra: { route: '/tasks' },
      // "Mark done" action → handler in App.tsx calls
      // useTaskStore.setComplete(taskId, true). Task ID rides in the action's
      // extra so the handler knows which task to complete without round-
      // tripping through the route. Notification auto-dismisses on action
      // tap; no separate cancel call required.
      actions: [
        { id: 'done', title: 'Mark done', extra: { taskId: task.id } },
      ],
    });
  } catch (e) {
    console.warn('[taskReminders] schedule', task.id, (e as Error).message);
  }
}

/** Cancel the reminder for one task. Safe to call on tasks that never had
 *  one — the underlying plugin no-ops on unknown IDs. */
export async function cancelTaskReminder(taskId: string): Promise<void> {
  await cancelNotifications([taskNotifId(taskId)]);
}

/** Wipe + re-arm all pending task notifications.
 *
 *  Step 1: cancelCategory('tasks') drops every pending alarm in the tasks
 *  ID range. This is the only way to clear notifs for tasks that no longer
 *  exist (deleted on another device, synced down, and now stale on ours).
 *
 *  Step 2: re-schedule for every currently-incomplete task with a future
 *  due date.
 *
 *  Called on app start from AppShell, and from the Settings toggle when
 *  the user flips Task Reminders to ON. */
export async function reconcileTaskReminders(tasks: Task[]): Promise<void> {
  // Always cancel first — if master is off (or category off) we want stale
  // alarms gone regardless. scheduleTaskReminder itself bails on either
  // toggle being off, so the loop below is a no-op in that case.
  await cancelCategory('tasks');
  const settings = useSettingsStore.getState();
  if (!settings.notifMasterEnabled) return;
  if (!settings.notifTasksEnabled) return;
  for (const t of tasks) {
    await scheduleTaskReminder(t);
  }
}

/** Convenience: reconcile using the current task store state. Used by the
 *  Settings toggle handler. */
export async function rearmTaskReminders(): Promise<void> {
  await reconcileTaskReminders(useTaskStore.getState().tasks);
}
