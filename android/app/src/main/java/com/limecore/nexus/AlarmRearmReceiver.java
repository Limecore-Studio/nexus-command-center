package com.limecore.nexus;

// v1.18.1 (NCC#168) — re-arms NCC's reminders after a reboot, without the app
// being opened. Android drops every AlarmManager alarm when the device
// restarts; until now they stayed gone until NCC was launched and its JS
// scheduled them again. NexusNotificationsPlugin.armAlarm stores a spec for
// each alarm it sets (cancel and a fired one-shot remove it), and this
// receiver rebuilds the alarms from those specs:
//
//   • daily/weekly reminders: at the stored next time if it is still ahead,
//     else at their next occurrence (NotificationAlarmReceiver.nextDailyFire /
//     nextWeeklyFire, the same rules the receiver's own re-arm uses);
//   • one-shots still ahead: at their time;
//   • anything that came due while the phone was off: fired once, now, if it
//     is at most LATE_GRACE_MS overdue (a reminder 2 minutes out when the
//     phone restarted still arrives); older one-shots are dropped, not fired,
//     and older daily/weekly ones wait for their next occurrence.
//
// Boot only, not MY_PACKAGE_REPLACED: alarms survive an app update, and an
// inexact alarm that Doze is still holding past its time would be dropped by
// these rules on an overnight auto-update. Each alarm is set with the
// PendingIntent cancel() looks up (alarmPendingIntent: request code = id, an
// intent for NotificationAlarmReceiver with no action), so it replaces any
// alarm still set under that id rather than adding a second one.
//
// Not handled: TIME_SET / TIMEZONE_CHANGED (RTC alarms survive both and the
// daily/weekly re-arm reads the zone when it fires), and a force-stop, which
// Samsung's "deep sleeping apps" amounts to: Android clears the alarms AND
// delivers no broadcasts, BOOT_COMPLETED included, to a stopped app until it
// is opened again. Nor LOCKED_BOOT_COMPLETED: the specs live in
// credential-protected storage, readable only after the first unlock, which
// is when BOOT_COMPLETED arrives.

import android.app.AlarmManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

import org.json.JSONObject;

import java.util.Map;

public class AlarmRearmReceiver extends BroadcastReceiver {

    private static final String TAG = "NexusNotifications";

    // v1.18.1 (NCC#168) — how overdue a reminder may be and still fire once
    // after a reboot. A restart takes a minute or two, so a reminder due
    // during it should not be lost; a reminder hours old is noise.
    static final long LATE_GRACE_MS = 5L * 60L * 1000L;

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent == null ? null : intent.getAction();
        // The manifest filter admits only this; anything else is ignored.
        if (!Intent.ACTION_BOOT_COMPLETED.equals(action)) {
            return;
        }
        AlarmManager am = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (am == null) {
            Log.w(TAG, "AlarmManager unavailable; reminders not re-armed after " + action);
            return;
        }
        int armed = 0;
        int dropped = 0;
        // One pass under the plugin's lock, so a schedule() or cancel() from a
        // JS start in the meantime lands wholly before or after it.
        synchronized (NexusNotificationsPlugin.SPECS_LOCK) {
            long now = System.currentTimeMillis();
            for (Map.Entry<Integer, JSONObject> e : NexusNotificationsPlugin.readSpecs(context).entrySet()) {
                try {
                    if (rearmOne(context, am, e.getKey(), e.getValue(), now)) {
                        armed++;
                    } else {
                        dropped++;
                    }
                } catch (RuntimeException ex) {
                    // One bad spec must not stop the rest.
                    Log.w(TAG, "Re-arm failed for id=" + e.getKey() + ": " + ex.getMessage());
                }
            }
        }
        Log.i(TAG, "Re-armed " + armed + " reminder(s), dropped " + dropped + " stale, after " + action);
    }

    /** v1.18.1 (NCC#168) — re-arm one stored alarm; false if it was dropped. */
    static boolean rearmOne(Context context, AlarmManager am, int id, JSONObject spec, long now) {
        long at = spec.optLong("at", 0L);
        Intent intent = NexusNotificationsPlugin.intentFromSpec(context, id, spec);

        if (at > now) {
            // Still ahead: the time it was set for.
            NexusNotificationsPlugin.armAlarm(context, am, id, intent, at);
            return true;
        }
        if (at > 0 && now - at <= LATE_GRACE_MS) {
            // Came due while the phone was off, a few minutes ago: fire it once,
            // now. EXTRA_AT keeps the stored time, so the fire matches the spec
            // (a one-shot then forgets it; a daily/weekly one re-arms itself).
            NexusNotificationsPlugin.armAlarm(context, am, id, intent, now + 1000L);
            return true;
        }

        String every = spec.optString("every", "");
        int hour = spec.optInt("hour", -1);
        int minute = spec.optInt("minute", -1);
        int weekday = spec.optInt("weekday", -1);
        boolean timeOk = hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
        long next = -1L;
        if ("day".equals(every) && timeOk) {
            next = NotificationAlarmReceiver.nextDailyFire(hour, minute, now);
        } else if ("week".equals(every) && timeOk && weekday >= 0 && weekday <= 6) {
            next = NotificationAlarmReceiver.nextWeeklyFire(weekday, hour, minute, now);
        }
        if (next > now) {
            // Missed while off, too long ago to fire: its next occurrence.
            intent.putExtra(NexusNotificationsPlugin.EXTRA_AT, next);
            NexusNotificationsPlugin.armAlarm(context, am, id, intent, next);
            return true;
        }

        // A one-shot (or a repeating spec with no usable time) that is long
        // overdue: drop it rather than fire a stale reminder, and forget its
        // spec (cancelAlarm also clears any alarm still set under the id).
        NexusNotificationsPlugin.cancelAlarm(context, am, id);
        return false;
    }
}
