// Typed JS-side binding for our custom NexusNotifications Capacitor plugin
// (defined in android/app/src/main/java/com/limecore/nexus/NexusNotificationsPlugin.java).
//
// We use Capacitor.registerPlugin directly rather than depending on
// @capacitor/local-notifications. The third-party plugin's bridge was
// hanging permanently on the target device (no resolution, no rejection
// — promises just never settled). This wrapper talks to OUR native code,
// which we've validated end-to-end:
//
//   • requestPermission → native uses ActivityCompat.checkSelfPermission
//     + the Capacitor permission framework
//   • schedule         → native uses AlarmManager.setAndAllowWhileIdle
//   • cancel/getPending → native tracks IDs in SharedPreferences since
//     AlarmManager has no enumeration API
//   • notificationTap  → native broadcasts via plugin.notifyListeners
//     after MainActivity extracts the route from the launch intent
//
// On web (dev preview) the native methods don't exist — Capacitor falls
// back to a default web plugin that throws "method not implemented".
// Callers must check Capacitor.isNativePlatform() before invoking. The
// outer notifications.ts handles this gracefully.

import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';

interface PermissionResult {
  granted: boolean;
}

export interface ChannelSpec {
  id: string;
  name?: string;
  description?: string;
  // Android NotificationManager.IMPORTANCE_* — LOW=2, DEFAULT=3, HIGH=4.
  importance?: number;
}

/** One inline action button on the notification. The Java side renders
 *  these via NotificationCompat.addAction; clicks fire the
 *  `notificationAction` event with this action's `id`. Auto-dismisses
 *  the source notification on tap. */
export interface NotificationAction {
  /** Stable identifier compared in the JS event handler. Keep short. */
  id: string;
  /** Visible button label (Android wraps at ~12 chars; keep it shorter). */
  title: string;
  /** Optional route to navigate to after the action fires. */
  route?: string;
  /** Optional payload — JSON-serialized into intent extras and re-emitted
   *  as `extraJson` in the action event. Use for IDs the handler needs
   *  (e.g. taskId for "Mark done"). Must be plain JSON-able data. */
  extra?: Record<string, unknown>;
}

interface ScheduleSpec {
  // Stable numeric ID. Re-scheduling with the same ID overwrites the
  // previous alarm (via PendingIntent.FLAG_UPDATE_CURRENT on the native
  // side).
  id: number;
  title: string;
  body: string;
  /** Notification channel id. Must have been created via createChannel
   *  first (or matched a system channel). */
  channelId: string;
  /** When to fire (ms epoch). Past values are floored to "1s from now"
   *  on the native side to avoid silently dropping the notification. */
  atMillis?: number;
  /** Arbitrary payload — only `route` is read on tap. Keep small; this
   *  rides through the AlarmManager intent extras. */
  extra?: Record<string, unknown> & { route?: string };
  /** Up to ~3 inline action buttons. Per Android UI conventions, more
   *  than 3 won't all be visible; the OS may collapse extras into an
   *  overflow. */
  actions?: NotificationAction[];
  /** v1.18.1 (NCC#138): 'day' makes the receiver re-arm the alarm for the
   *  next occurrence of its wall-clock time each time it fires. v1.18.1
   *  (NCC#168): 'week' does the same for the next `weekday`. */
  every?: 'day' | 'week';
  /** v1.18.1 (NCC#138): with every: 'day' or 'week', that wall-clock time
   *  (hour 0-23, minute 0-59). Optional: the native side otherwise reads it
   *  off atMillis, which is wrong for a time in a skipped DST hour (02:30
   *  resolves to 03:30). */
  hour?: number;
  minute?: number;
  /** v1.18.1 (NCC#168): with every: 'week', the day it repeats on, 0 = Sunday
   *  .. 6 = Saturday (Date.getDay()). Optional, read off atMillis otherwise. */
  weekday?: number;
}

interface ScheduleResult {
  id: number;
  /** Actual fire time after past-time flooring (ms epoch). */
  at: number;
}

interface CancelSpec {
  ids: number[];
}

interface PendingResult {
  ids: number[];
}

interface NotificationTapEvent {
  route: string;
  /** v1.18.1 (NCC#169): the queued copy's seq (see QueuedTap). -1 when the
   *  native side could not queue it. */
  seq?: number;
}

/** Fires when the user taps an action button on a notification (NOT the
 *  notification body itself — that's `notificationTap`). The source
 *  notification auto-dismisses on the native side before this event
 *  reaches JS. */
interface NotificationActionEvent {
  /** Matches the `id` field of the action that was tapped. */
  actionId: string;
  /** Route from the action's `route` field. Empty string if unset. */
  route: string;
  /** JSON-encoded string of the action's `extra` payload. Empty string
   *  if no extra was set. Caller decodes via JSON.parse. */
  extraJson: string;
  /** v1.18.1 (NCC#169): the queued copy's seq (see QueuedAction). */
  seq?: number;
}

/** v1.18.1 (NCC#169): a tap the native side queued (persisted, at most 20,
 *  oldest first). `seq` comes from one counter that only goes up; the entry
 *  stays queued until ackPendingTaps names it. `at` is when it was queued
 *  (ms epoch). */
export interface QueuedTap {
  seq: number;
  route: string;
  at?: number;
}

/** v1.18.1 (NCC#169): an action the native side queued; as QueuedTap. */
export interface QueuedAction {
  seq: number;
  actionId: string;
  route: string;
  extraJson: string;
  at?: number;
}

/** Result of consumePendingTap — see plugin docstring. Empty route means
 *  the buffer was clean. v1.3.1 BUG-14 cold-start drain. v1.18.1 (NCC#169):
 *  `taps` is the whole queue, and `route` the newest one's (what the old
 *  single slot held). */
export interface PendingTapResult {
  route: string;
  taps?: QueuedTap[];
}

/** Result of consumePendingAction — see plugin docstring. Empty actionId
 *  means the buffer was clean. v1.3.1 BUG-14 cold-start drain. v1.18.1
 *  (NCC#169): `actions` is the whole queue, oldest first, and the top-level
 *  fields are the oldest one's. */
export interface PendingActionResult {
  actionId: string;
  route: string;
  extraJson: string;
  actions?: QueuedAction[];
}

export interface NexusNotificationsPlugin {
  checkPermission(): Promise<PermissionResult>;
  requestPermission(): Promise<PermissionResult>;
  createChannel(spec: ChannelSpec): Promise<void>;
  schedule(spec: ScheduleSpec): Promise<ScheduleResult>;
  cancel(spec: CancelSpec): Promise<void>;
  getPending(): Promise<PendingResult>;
  /** Read the cold-start tap queue. Called by onNotificationTap after
   *  addListener resolves to recover a tap that landed before JS subscribed
   *  (cold start from a notification tap). v1.3.1 BUG-14. v1.18.1 (NCC#169):
   *  it no longer clears anything; ackPendingTaps does. */
  consumePendingTap(): Promise<PendingTapResult>;
  /** Read the cold-start action queue. Same rationale as consumePendingTap.
   *  v1.3.1 BUG-14. v1.18.1 (NCC#169): cleared by ackPendingActions. */
  consumePendingAction(): Promise<PendingActionResult>;
  /** v1.18.1 (NCC#169): drop these taps from the native queue. */
  ackPendingTaps(spec: { seqs: number[] }): Promise<void>;
  /** v1.18.1 (NCC#169): drop these actions from the native queue, once JS
   *  has applied them. */
  ackPendingActions(spec: { seqs: number[] }): Promise<void>;
  addListener(
    eventName: 'notificationTap',
    listener: (event: NotificationTapEvent) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'notificationAction',
    listener: (event: NotificationActionEvent) => void,
  ): Promise<PluginListenerHandle>;
}

// The plugin name MUST match @CapacitorPlugin(name = "NexusNotifications")
// on the native side.
export const NexusNotifications =
  registerPlugin<NexusNotificationsPlugin>('NexusNotifications');
