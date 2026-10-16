package com.limecore.nexus;

// Triggered by AlarmManager when a scheduled notification's fire time
// arrives. Builds + posts the notification via NotificationCompat, and
// wires the contentIntent to open MainActivity with the route extra so
// the JS-side tap handler can navigate.
//
// All work happens synchronously inside onReceive — broadcast receivers
// have ~10s before the system kills them. Posting a notification is far
// under that budget.

import android.app.AlarmManager;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.util.Log;

import androidx.core.app.NotificationCompat;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.Calendar;

public class NotificationAlarmReceiver extends BroadcastReceiver {

    private static final String TAG = "NexusNotifications";

    // Intent extra used by MainActivity to identify a tap-launched intent
    // and pull out the route. Lives here (not in MainActivity) because the
    // receiver is the one that writes it into the contentIntent.
    public static final String EXTRA_TAP_ROUTE = "nexus_tap_route";

    @Override
    public void onReceive(Context context, Intent intent) {
        // v1.18.1 (NCC#138): a daily reminder re-arms itself first, so a
        // failure further down cannot stop tomorrow's. v1.18.1 (NCC#168): a
        // weekly one too, for next week's.
        rearmIfRepeating(context, intent);

        int id = intent.getIntExtra(NexusNotificationsPlugin.EXTRA_ID, 0);
        String title = intent.getStringExtra(NexusNotificationsPlugin.EXTRA_TITLE);
        String body = intent.getStringExtra(NexusNotificationsPlugin.EXTRA_BODY);
        String channelId = intent.getStringExtra(NexusNotificationsPlugin.EXTRA_CHANNEL_ID);
        String route = intent.getStringExtra(NexusNotificationsPlugin.EXTRA_ROUTE);
        if (channelId == null || channelId.isEmpty()) channelId = "default";
        if (title == null) title = "";
        if (body == null) body = "";

        // Build the tap intent: open MainActivity with the route packed as
        // an extra. SINGLE_TOP so we don't stack duplicate activities when
        // the user taps multiple notifications in succession.
        Intent tapIntent = new Intent(context, MainActivity.class);
        tapIntent.setFlags(
            Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP
        );
        if (route != null) tapIntent.putExtra(EXTRA_TAP_ROUTE, route);

        // Unique request code per notification so each tap intent is its own
        // PendingIntent and one doesn't overwrite another. Use the notif id —
        // they're already unique: each category owns a disjoint ID range
        // (1000-11099 since v1.18.1, NCC#168; see ID_RANGES in notifications.ts).
        int piFlags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            piFlags |= PendingIntent.FLAG_IMMUTABLE;
        }
        PendingIntent contentPi = PendingIntent.getActivity(
            context, id, tapIntent, piFlags
        );

        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, channelId)
            // ic_stat_nexus is the white-on-transparent silhouette derived from
            // the launcher icon (see derive_notification_icons.py in the
            // limecore registry repo). Status-bar icons MUST be monochrome per
            // Material guidelines or Android renders a generic exclamation
            // triangle in their place. Color tint applied below.
            .setSmallIcon(R.drawable.ic_stat_nexus)
            // Cyber Slate primary cyan (matches theme/colors.ts primary).
            // Applied as the channel/notif accent color on Android 5+ — shows
            // as the small icon's tint and as the heads-up accent border.
            .setColor(0xFF00D4FF)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setContentIntent(contentPi)
            .setAutoCancel(true) // dismiss on tap
            .setPriority(NotificationCompat.PRIORITY_DEFAULT);

        // Action buttons. JSON shape: [{id, title, route?, extra?}]. Each
        // entry becomes a NotificationCompat.Action whose PendingIntent
        // targets NotificationActionReceiver. We use icon=0 (no icon) so
        // the action row stays a clean text-only button. Each action gets
        // a unique requestCode so different actions on the same notification
        // don't share a PendingIntent.
        String actionsJson = intent.getStringExtra(NexusNotificationsPlugin.EXTRA_ACTIONS_JSON);
        if (actionsJson != null && !actionsJson.isEmpty()) {
            try {
                JSONArray arr = new JSONArray(actionsJson);
                for (int i = 0; i < arr.length(); i++) {
                    JSONObject a = arr.optJSONObject(i);
                    if (a == null) continue;
                    String actId = a.optString("id", "");
                    String actTitle = a.optString("title", "");
                    if (actId.isEmpty() || actTitle.isEmpty()) continue;
                    String actRoute = a.optString("route", null);
                    // Re-stringify the per-action extra so we can pack it
                    // through the action's intent extras (the plugin's JS
                    // side parses it back). Null/missing extra → null.
                    String actExtraJson = a.has("extra") ? a.getJSONObject("extra").toString() : null;

                    Intent actIntent = new Intent(context, NotificationActionReceiver.class);
                    actIntent.putExtra(NotificationActionReceiver.EXTRA_NOTIF_ID, id);
                    actIntent.putExtra(NotificationActionReceiver.EXTRA_ACTION_ID, actId);
                    if (actRoute != null) actIntent.putExtra(NotificationActionReceiver.EXTRA_ACTION_ROUTE, actRoute);
                    if (actExtraJson != null) actIntent.putExtra(NotificationActionReceiver.EXTRA_ACTION_EXTRA_JSON, actExtraJson);

                    // Unique requestCode per (notifId, actionIndex). Multiply
                    // by 100 to avoid collision with other PendingIntents that
                    // use the notifId directly (e.g. the tap content intent).
                    int requestCode = id * 100 + i + 1;
                    PendingIntent actPi = PendingIntent.getBroadcast(
                        context, requestCode, actIntent, piFlags
                    );
                    builder.addAction(0, actTitle, actPi);
                }
            } catch (JSONException e) {
                Log.w(TAG, "Failed to parse actions JSON: " + e.getMessage());
            }
        }

        NotificationManager nm = (NotificationManager)
            context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) {
            Log.w(TAG, "NotificationManager unavailable; cannot post id=" + id);
            return;
        }
        try {
            nm.notify(id, builder.build());
        } catch (SecurityException se) {
            // Android 13+: posting without POST_NOTIFICATIONS throws here.
            // Log and bail — the JS-side scheduler should have checked perm
            // before scheduling, but defensively we don't crash the receiver.
            Log.w(TAG, "POST_NOTIFICATIONS not granted: " + se.getMessage());
        }
    }

    /** v1.18.1 (NCC#138) — `every: "day"` used to be ignored, so the daily
     *  habit reminder fired once and then stayed silent until the app was
     *  opened again. When this alarm fires, schedule it again for the next
     *  occurrence of the wall-clock time it was asked for (EXTRA_HOUR /
     *  EXTRA_MINUTE), in the device's time zone as it is now. Built by the
     *  plugin's alarmPendingIntent from a fresh intent for this receiver with
     *  the extras copied over, so cancel() in the plugin still finds it.
     *  Not covered: a reboot or force-stop clears all alarms until the app
     *  is opened again (no boot receiver; the owner's call, see NCC#138).
     *
     *  v1.18.1 (NCC#168) — `every: "week"` the same way: a specific-days habit
     *  reminder has one alarm per chosen day (EXTRA_WEEKDAY), each re-armed
     *  for the same weekday and wall-clock time a week later. */
    private static void rearmIfRepeating(Context context, Intent intent) {
        String every = intent.getStringExtra(NexusNotificationsPlugin.EXTRA_EVERY);
        boolean weekly = "week".equals(every);
        if (!weekly && !"day".equals(every)) return;
        int id = intent.getIntExtra(NexusNotificationsPlugin.EXTRA_ID, 0);
        int hour = intent.getIntExtra(NexusNotificationsPlugin.EXTRA_HOUR, -1);
        int minute = intent.getIntExtra(NexusNotificationsPlugin.EXTRA_MINUTE, -1);
        if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
            Log.w(TAG, "Repeating reminder id=" + id + " has no time of day; not re-armed");
            return;
        }
        long now = System.currentTimeMillis();
        long fireAt;
        if (weekly) {
            int weekday = intent.getIntExtra(NexusNotificationsPlugin.EXTRA_WEEKDAY, -1);
            if (weekday < 0 || weekday > 6) {
                Log.w(TAG, "Weekly reminder id=" + id + " has no weekday; not re-armed");
                return;
            }
            fireAt = nextWeeklyFire(weekday, hour, minute, now);
        } else {
            fireAt = nextDailyFire(hour, minute, now);
        }

        Intent again = new Intent(context, NotificationAlarmReceiver.class);
        again.putExtras(intent);
        PendingIntent pi = NexusNotificationsPlugin.alarmPendingIntent(context, id, again);
        AlarmManager am = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (am == null) {
            Log.w(TAG, "AlarmManager unavailable; repeating reminder id=" + id + " not re-armed");
            return;
        }
        NexusNotificationsPlugin.setAlarm(am, fireAt, pi);
    }

    /** v1.18.1 (NCC#138) — the next hour:minute on the wall clock strictly
     *  after `now`, in the current default time zone (read at each call, so a
     *  zone change since scheduling is followed).
     *
     *  Today or tomorrow is chosen by comparing wall-clock fields, not
     *  instants. Alarms never fire early, so a reminder that just fired reads
     *  at or past its hour:minute and goes to tomorrow, even in the repeated
     *  hour of a DST fall-back, where today's 01:30 can resolve to the later
     *  of the two instants and an instant comparison would fire it twice. One
     *  that fired late, past midnight, still gets today's. A time in the
     *  skipped hour of a spring-forward day resolves past the gap (lenient
     *  Calendar), and the next day is back on time: nothing carries over. */
    static long nextDailyFire(int hour, int minute, long now) {
        Calendar next = Calendar.getInstance();
        next.setTimeInMillis(now);
        int nowHour = next.get(Calendar.HOUR_OF_DAY);
        int nowMinute = next.get(Calendar.MINUTE);
        // v1.18.1 (NCC#168) — the day first, then the time of day. Set first
        // and then moved onto a spring-forward day, a time in the skipped hour
        // came out an hour early (02:30 → 01:30 standard time), not past the
        // gap as described above; set last, it resolves to 03:30.
        if (nowHour > hour || (nowHour == hour && nowMinute >= minute)) {
            next.add(Calendar.DAY_OF_MONTH, 1);
        }
        next.set(Calendar.HOUR_OF_DAY, hour);
        next.set(Calendar.MINUTE, minute);
        next.set(Calendar.SECOND, 0);
        next.set(Calendar.MILLISECOND, 0);
        // Belt and braces for a resolution quirk: never at or before now.
        while (next.getTimeInMillis() <= now) {
            next.add(Calendar.DAY_OF_MONTH, 1);
        }
        return next.getTimeInMillis();
    }

    /** v1.18.1 (NCC#168) — the next `weekday` (0 = Sunday .. 6 = Saturday, as
     *  JS getDay()) at hour:minute on the wall clock strictly after `now`, in
     *  the current default time zone. Same rules as nextDailyFire: the day is
     *  chosen by comparing wall-clock fields, so a reminder that just fired
     *  goes to next week, and one that fired late, past midnight, still gets
     *  the coming one (six days on, not thirteen). */
    static long nextWeeklyFire(int weekday, int hour, int minute, long now) {
        Calendar next = Calendar.getInstance();
        next.setTimeInMillis(now);
        int nowWeekday = next.get(Calendar.DAY_OF_WEEK) - Calendar.SUNDAY; // SUNDAY is 1
        int nowHour = next.get(Calendar.HOUR_OF_DAY);
        int nowMinute = next.get(Calendar.MINUTE);
        int days = (weekday - nowWeekday + 7) % 7;
        if (days == 0 && (nowHour > hour || (nowHour == hour && nowMinute >= minute))) {
            days = 7;
        }
        // The day first, then the time of day (see nextDailyFire).
        next.add(Calendar.DAY_OF_MONTH, days);
        next.set(Calendar.HOUR_OF_DAY, hour);
        next.set(Calendar.MINUTE, minute);
        next.set(Calendar.SECOND, 0);
        next.set(Calendar.MILLISECOND, 0);
        // Belt and braces, as above: never at or before now.
        while (next.getTimeInMillis() <= now) {
            next.add(Calendar.DAY_OF_MONTH, 7);
        }
        return next.getTimeInMillis();
    }
}
