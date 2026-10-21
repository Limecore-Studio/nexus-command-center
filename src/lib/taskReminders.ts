// Task due-date reminders.
//
// Schedules a local notification at 09:00 on the task's due date. Cancels
// it when the task is completed, deleted, or has its due date cleared.
//
// Why 09:00 local: the Task type stores `dueDate` as YYYY-MM-DD with no
// time-of-day. A notification fired at midnight is silly; one fired during
// the day means the user has at least the morning to react. 09:00 is a
// reasonable "start of working day" default. If we later add a time-of-day
// field on Task, this module can read it.
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
import { cancelCategory, cancelNotifications, ID_RANGES, reminderEpoch, scheduleNotification } from './notifications';
import { useSettingsStore } from '../store/useSettingsStore';
import { useTaskStore } from '../store/useTaskStore';

const TASKS_BASE = ID_RANGES.tasks.base;
const TASKS_SIZE = ID_RANGES.tasks.size;

function taskNotifId(taskId: string): number {
  let hash = 0;
  for (const ch of taskId) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return TASKS_BASE + (Math.abs(hash) % TASKS_SIZE);
}

/** Convert a YYYY-MM-DD dueDate to a Date at 09:00 local time on that day.
 *  Returns null if the resulting time is in the past (the plugin would
 *  reject it; we'd rather skip than schedule something stale). */
function dueAtNotifTime(dueDate: string): Date | null {
  const [y, m, d] = dueDate.split('-').map(Number);
  if (!y || !m || !d) return null;
  const dt = new Date(y, m - 1, d, 9, 0, 0, 0);
  if (dt.getTime() <= Date.now()) return null;
  return dt;
}

/** Schedule a reminder for one task. No-ops if:
 *    • the tasks notification toggle is off
 *    • the task has no dueDate, is already completed, or the 9am-on-dueDate
 *      time has already passed
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
      // useTaskStore.toggleComplete(taskId). Task ID rides in the action's
      // extra so the handler knows which task to flip without round-
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
 *  the user flips Task Reminders to ON. v1.18.1 (NCC#186): also after each
 *  successful pull, through reconcileTaskRemindersIfChanged. */
export async function reconcileTaskReminders(
  tasks: Task[],
  shouldContinue: () => boolean = () => true,
): Promise<void> {
  // v1.18.1 (NCC#186) — taken before the first await, so a cancelAllReminders
  // that runs while this is under way leaves the memo below stale.
  const epoch = reminderEpoch();
  const sig = taskReminderSignature(tasks);
  // Always cancel first — if master is off (or category off) we want stale
  // alarms gone regardless. scheduleTaskReminder itself bails on either
  // toggle being off, so the loop below is a no-op in that case.
  await cancelCategory('tasks');
  const settings = useSettingsStore.getState();
  if (settings.notifMasterEnabled && settings.notifTasksEnabled) {
    for (const t of tasks) {
      // v1.18.1 (NCC#186) — a sign-out during the loop stops it here.
      if (!shouldContinue()) return;
      await scheduleTaskReminder(t);
    }
  }
  armed = { sig, epoch };
}

// v1.18.1 (NCC#186) — what the last full reconcile armed, so a sync can
// re-arm only when the tasks changed. `epoch` ties it to reminderEpoch():
// after a cancelAllReminders (sign-out, wipe, master off) nothing counts as
// armed any more.
let armed: { sig: string; epoch: number } | null = null;

/** The fields a reminder is built from, plus the two toggles. Tasks that can
 *  never get one (done, or no due date) are left out. */
function taskReminderSignature(tasks: Task[]): string {
  const s = useSettingsStore.getState();
  const rows = tasks
    .filter((t) => !t.completed && t.dueDate)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((t) => [t.id, t.title, t.dueDate, t.priority, t.notes ?? '']);
  return JSON.stringify([s.notifMasterEnabled, s.notifTasksEnabled, rows]);
}

/** v1.18.1 (NCC#186) — reconcile, unless the last reconcile already armed
 *  exactly these tasks and nothing has cancelled everything since. Called
 *  after each successful pull (useSyncStore): AppShell's mount reconcile runs
 *  before the first pull, so tasks that arrive with it (sign-in after "Wipe
 *  local data", a new account's first sync, a device that was offline at
 *  sign-in) got no reminder until the next app start. */
export async function reconcileTaskRemindersIfChanged(
  tasks: Task[],
  shouldContinue: () => boolean = () => true,
): Promise<boolean> {
  if (armed && armed.epoch === reminderEpoch() && armed.sig === taskReminderSignature(tasks)) {
    return false;
  }
  if (!shouldContinue()) return false;
  await reconcileTaskReminders(tasks, shouldContinue);
  return true;
}

/** Convenience: reconcile using the current task store state. Used by the
 *  Settings toggle handler. */
export async function rearmTaskReminders(): Promise<void> {
  await reconcileTaskReminders(useTaskStore.getState().tasks);
}
