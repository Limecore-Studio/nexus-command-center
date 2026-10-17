package com.limecore.nexus;

// Custom Capacitor plugin written from scratch to replace
// @capacitor/local-notifications. The third-party plugin's JS-to-native
// bridge was hanging permanently on this device after install (calls to
// checkPermissions / requestPermissions never resolved), and routing
// around it with timeouts and bypass buttons was a workaround, not a fix.
//
// This plugin talks directly to:
//   • NotificationManager  — to create channels and post notifications
//   • AlarmManager         — to schedule future notifications
//   • NotificationManagerCompat.from(ctx).areNotificationsEnabled()
//     for the permission state on Android 12 and below
//   • Activity.requestPermissions for POST_NOTIFICATIONS on Android 13+
//
// The scheduled-notification flow:
//   1. JS calls schedule({ id, title, body, channelId, atMillis, extra })
//   2. We build a PendingIntent that targets NotificationAlarmReceiver
//      with the title/body/channelId/extra packed into the intent extras
//   3. AlarmManager fires the intent at atMillis
//   4. The receiver builds + posts the notification via NotificationManager
//
// No FCM, no Google Play Services — F-Droid clean.

import android.Manifest;
import android.app.AlarmManager;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;

import androidx.core.app.ActivityCompat;
import androidx.core.app.NotificationManagerCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.Calendar;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.Map;
import java.util.Set;

@CapacitorPlugin(
    name = "NexusNotifications",
    permissions = {
        @Permission(
            alias = "notifications",
            strings = { Manifest.permission.POST_NOTIFICATIONS }
        )
    }
)
public class NexusNotificationsPlugin extends Plugin {

    // SharedPreferences key holding the set of currently-scheduled notification
    // IDs as JSON-encoded strings. We track this ourselves because
    // AlarmManager has no "list all pending alarms for this app" API.
    // Without it, cancelByCategory() in JS couldn't enumerate IDs to cancel.
    private static final String PREFS = "nexus_notifications";
    private static final String KEY_SCHEDULED_IDS = "scheduled_ids";

    // Intent extra keys used to pass notification data to NotificationAlarmReceiver.
    public static final String EXTRA_ID = "nexus_id";
    public static final String EXTRA_TITLE = "nexus_title";
    public static final String EXTRA_BODY = "nexus_body";
    public static final String EXTRA_CHANNEL_ID = "nexus_channel_id";
    public static final String EXTRA_ROUTE = "nexus_route";
    // Action buttons: a JSON-stringified JSArray of {id, title, route?, extra?}
    // packed into the alarm intent and unpacked by NotificationAlarmReceiver
    // when building the NotificationCompat.Builder. Strings (rather than
    // structured parcelable) so intent serialization stays simple and the
    // payload can pass through PendingIntent boundaries without custom
    // Parcelable plumbing.
    public static final String EXTRA_ACTIONS_JSON = "nexus_actions_json";
    // v1.18.1 (NCC#138): repeat cadence ("day" or absent) and, for a daily
    // alarm, the wall-clock hour (0-23) and minute it was asked for, so
    // NotificationAlarmReceiver can re-arm it for that local time when it
    // fires. The time of day, not the instant: an instant plus a day drifts
    // for good after a time in the skipped DST hour, and keeps the old zone's
    // time after the device changes time zone.
    public static final String EXTRA_EVERY = "nexus_every";
    public static final String EXTRA_HOUR = "nexus_hour";
    public static final String EXTRA_MINUTE = "nexus_minute";
    // v1.18.1 (NCC#168) — with EXTRA_EVERY "week", the day of the week it
    // repeats on, 0 = Sunday .. 6 = Saturday (JS Date.getDay(), not
    // Calendar.DAY_OF_WEEK), so a specific-days habit reminder re-arms itself
    // for the same weekday and time one week later.
    public static final String EXTRA_WEEKDAY = "nexus_weekday";
    // v1.18.1 (NCC#168) — the instant this alarm was set for, so a fired
    // one-shot forgets its stored spec only if that spec is still the one
    // that fired (not a newer schedule() under the same id). Extras do not
    // count in PendingIntent matching, so cancel() still finds the alarm.
    public static final String EXTRA_AT = "nexus_at";

    // v1.18.1 (NCC#168) — what each scheduled alarm needs to be rebuilt after
    // a reboot without opening NCC (AlarmRearmReceiver): its own preference
    // file, key = the notification id, value = a JSON spec (see specFromIntent).
    // One key per alarm so a schedule() is one small write, not a rewrite of
    // every alarm's spec. Written whenever an alarm is set (armAlarm), removed
    // on cancel (cancelAlarm) and when a one-shot fires; a daily/weekly one's
    // "at" moves on each time it re-arms itself.
    private static final String SPECS_PREFS = "nexus_alarm_specs";
    // Guards every alarm set/cancel together with its spec write: receivers
    // run on the main thread, plugin methods on the plugin thread. Package-
    // private because AlarmRearmReceiver holds it across its whole pass.
    static final Object SPECS_LOCK = new Object();

    // v1.18.1 (NCC#169) — taps and actions waiting for JS, persisted. They
    // were one static slot in memory: an action whose receiver started the
    // process was lost when Android killed it before NCC was opened, and a
    // second "Mark done" tapped while NCC was closed overwrote the first.
    // Each queue is a JSON array of entries, oldest first, each with a "seq"
    // (from one counter that only goes up) that JS acknowledges once it has
    // applied the entry; only then is it removed.
    private static final String KEY_PENDING_TAPS = "pending_taps";
    private static final String KEY_PENDING_ACTIONS = "pending_actions";
    private static final String KEY_PENDING_SEQ = "pending_seq";
    private static final int PENDING_MAX = 20;
    // Receivers run on the main thread, plugin methods on the plugin thread,
    // and every queue change is a read-modify-write of one preference.
    private static final Object PENDING_LOCK = new Object();

    // Singleton handle so the static action-receiver (which has no Plugin
    // reference of its own) can route events back into JS via this
    // instance's notifyListeners call. Set in load(), cleared by Capacitor's
    // plugin lifecycle if needed.
    private static NexusNotificationsPlugin sInstance = null;
    public static NexusNotificationsPlugin getInstance() { return sInstance; }

    // ─── Permission ─────────────────────────────────────────────────────

    @PluginMethod
    public void checkPermission(PluginCall call) {
        JSObject result = new JSObject();
        result.put("granted", isNotificationsGranted());
        call.resolve(result);
    }

    @PluginMethod
    public void requestPermission(PluginCall call) {
        // Android 12 and below have notification permission granted by default
        // (manifest declaration is enough). The runtime POST_NOTIFICATIONS
        // permission only exists on API 33+.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            JSObject result = new JSObject();
            result.put("granted", isNotificationsGranted());
            call.resolve(result);
            return;
        }
        // Already granted? Resolve immediately so JS doesn't hang waiting for
        // a permission dialog that won't appear.
        if (isNotificationsGranted()) {
            JSObject result = new JSObject();
            result.put("granted", true);
            call.resolve(result);
            return;
        }
        // Request the runtime permission. Capacitor's permission framework
        // handles the dialog + callback wiring; the PermissionCallback method
        // below resolves the original PluginCall once the user responds.
        requestPermissionForAlias("notifications", call, "notificationsPermissionCallback");
    }

    @PermissionCallback
    private void notificationsPermissionCallback(PluginCall call) {
        PermissionState state = getPermissionState("notifications");
        JSObject result = new JSObject();
        result.put("granted", state == PermissionState.GRANTED);
        call.resolve(result);
    }

    private boolean isNotificationsGranted() {
        // NotificationManagerCompat.areNotificationsEnabled() honors both the
        // runtime POST_NOTIFICATIONS perm (API 33+) AND the user's per-app
        // "Show notifications" toggle in system settings (all API levels).
        // Single source of truth for whether posting a notif will actually
        // surface on the lock screen / status bar.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            int check = ActivityCompat.checkSelfPermission(
                getContext(), Manifest.permission.POST_NOTIFICATIONS
            );
            if (check != PackageManager.PERMISSION_GRANTED) return false;
        }
        return NotificationManagerCompat.from(getContext()).areNotificationsEnabled();
    }

    // ─── Channels ───────────────────────────────────────────────────────

    @PluginMethod
    public void createChannel(PluginCall call) {
        String id = call.getString("id");
        String name = call.getString("name", id);
        String description = call.getString("description", "");
        Integer importance = call.getInt("importance", NotificationManager.IMPORTANCE_DEFAULT);
        if (id == null || id.isEmpty()) {
            call.reject("Missing channel id");
            return;
        }
        // Channels only exist on Android 8.0+. Below that the manager call
        // is a no-op but we resolve as success anyway so JS treats both
        // paths the same.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(id, name, importance);
            channel.setDescription(description);
            NotificationManager nm = (NotificationManager)
                getContext().getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) nm.createNotificationChannel(channel);
        }
        call.resolve();
    }

    // ─── Schedule / cancel ──────────────────────────────────────────────

    @PluginMethod
    public void schedule(PluginCall call) {
        Integer id = call.getInt("id");
        String title = call.getString("title", "");
        String body = call.getString("body", "");
        String channelId = call.getString("channelId", "default");
        Long atMillis = call.getLong("atMillis");
        JSObject extra = call.getObject("extra", new JSObject());
        JSArray actions = call.getArray("actions"); // optional
        String every = call.getString("every"); // optional; "day" or "week"
        Integer askedHour = call.getInt("hour"); // optional; with every "day" or "week"
        Integer askedMinute = call.getInt("minute");
        Integer askedWeekday = call.getInt("weekday"); // optional; with every "week", 0 = Sunday

        if (id == null) {
            call.reject("Missing id");
            return;
        }
        // Floor at "1 second from now" so a caller passing a slightly-past
        // time still gets a notification, matching the old plugin's behavior.
        long fireAt = atMillis != null ? atMillis : System.currentTimeMillis() + 1000L;
        if (fireAt <= System.currentTimeMillis()) {
            fireAt = System.currentTimeMillis() + 1000L;
        }

        Intent intent = new Intent(getContext(), NotificationAlarmReceiver.class);
        intent.putExtra(EXTRA_ID, id);
        intent.putExtra(EXTRA_TITLE, title);
        intent.putExtra(EXTRA_BODY, body);
        intent.putExtra(EXTRA_CHANNEL_ID, channelId);
        if (extra != null && extra.has("route")) {
            intent.putExtra(EXTRA_ROUTE, extra.getString("route"));
        }
        // Pack the actions array as a JSON string. The receiver re-parses
        // and iterates to build NotificationCompat.Action entries. We pass
        // it through Intent#putExtra (String) rather than Parcelable because
        // the alarm intent crosses a process boundary via AlarmManager and
        // simple primitives survive most reliably.
        if (actions != null && actions.length() > 0) {
            intent.putExtra(EXTRA_ACTIONS_JSON, actions.toString());
        }
        // v1.18.1 (NCC#168) — "week" too, for a specific-days habit reminder:
        // one alarm per chosen day, each re-armed a week later by the receiver.
        boolean weekly = "week".equals(every);
        // v1.18.1 (NCC#168) — see EXTRA_AT.
        intent.putExtra(EXTRA_AT, fireAt);
        if ("day".equals(every) || weekly) {
            intent.putExtra(EXTRA_EVERY, weekly ? "week" : "day");
            // The time of day JS passed, else the one the requested time shows
            // in the device's current default time zone. The requested time,
            // not fireAt, which is floored to "now + 1s" for a past request.
            Calendar asked = Calendar.getInstance();
            asked.setTimeInMillis(atMillis != null ? atMillis : fireAt);
            int hour;
            int minute;
            if (askedHour != null && askedMinute != null
                    && askedHour >= 0 && askedHour <= 23
                    && askedMinute >= 0 && askedMinute <= 59) {
                hour = askedHour;
                minute = askedMinute;
            } else {
                hour = asked.get(Calendar.HOUR_OF_DAY);
                minute = asked.get(Calendar.MINUTE);
            }
            intent.putExtra(EXTRA_HOUR, hour);
            intent.putExtra(EXTRA_MINUTE, minute);
            if (weekly) {
                // Same rule for the weekday. Calendar.SUNDAY is 1, JS's is 0.
                int weekday;
                if (askedWeekday != null && askedWeekday >= 0 && askedWeekday <= 6) {
                    weekday = askedWeekday;
                } else {
                    weekday = asked.get(Calendar.DAY_OF_WEEK) - Calendar.SUNDAY;
                }
                intent.putExtra(EXTRA_WEEKDAY, weekday);
            }
        }

        AlarmManager am = (AlarmManager) getContext().getSystemService(Context.ALARM_SERVICE);
        if (am == null) {
            call.reject("AlarmManager unavailable");
            return;
        }

        // Track the ID so cancelAll / getPending can enumerate it later.
        // v1.18.1 (NCC#168) — before armAlarm, so a stored spec is never one
        // that getPending, and so the reconcile, cannot see.
        addTrackedId(id);

        // v1.18.1 (NCC#168) — sets the alarm (alarmPendingIntent + setAlarm,
        // as before) and stores its spec, for the re-arm after a reboot.
        armAlarm(getContext(), am, id, intent, fireAt);

        JSObject result = new JSObject();
        result.put("id", id);
        result.put("at", fireAt);
        call.resolve(result);
    }

    /** The PendingIntent an alarm fires. Shared with NotificationAlarmReceiver's
     *  daily re-arm (v1.18.1, NCC#138) and, through armAlarm, the boot re-arm
     *  (v1.18.1, NCC#168), so all of them build exactly what cancel()
     *  looks up: request code = id, and an intent for NotificationAlarmReceiver
     *  with no action, data or categories (extras don't count in the match).
     *
     *  FLAG_UPDATE_CURRENT so re-scheduling with the same ID replaces
     *  the existing alarm cleanly. FLAG_IMMUTABLE is required on
     *  Android 12+ — Capacitor's min target is well above that. */
    static PendingIntent alarmPendingIntent(Context context, int id, Intent intent) {
        return PendingIntent.getBroadcast(
            context,
            id,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
    }

    /** Sets one alarm. Shared with NotificationAlarmReceiver, which re-arms
     *  daily reminders (v1.18.1, NCC#138), so both use the same alarm type.
     *
     *  RTC_WAKEUP wakes the device if asleep — necessary for time-of-day
     *  notifications like the 4:05pm market-close recap. setAndAllowWhileIdle
     *  adds Doze-mode tolerance (within OS-imposed quota) so the alarm still
     *  fires during long idle stretches; without it, doze can defer the alarm
     *  by hours. */
    static void setAlarm(AlarmManager am, long fireAt, PendingIntent pi) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, fireAt, pi);
        } else {
            am.set(AlarmManager.RTC_WAKEUP, fireAt, pi);
        }
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        JSArray ids = call.getArray("ids");
        if (ids == null) {
            call.reject("Missing ids");
            return;
        }
        AlarmManager am = (AlarmManager) getContext().getSystemService(Context.ALARM_SERVICE);
        NotificationManager nm = (NotificationManager)
            getContext().getSystemService(Context.NOTIFICATION_SERVICE);
        try {
            for (int i = 0; i < ids.length(); i++) {
                int id = ids.getInt(i);
                // v1.18.1 (NCC#168) — the same FLAG_NO_CREATE lookup and
                // am.cancel as before, plus the stored spec, so a cancelled
                // reminder does not come back at boot.
                cancelAlarm(getContext(), am, id);
                if (nm != null) nm.cancel(id); // also drop any already-posted notif
                removeTrackedId(id);
            }
        } catch (Exception e) {
            call.reject("Cancel failed: " + e.getMessage());
            return;
        }
        call.resolve();
    }

    // ─── Alarm specs, for the re-arm after a reboot (v1.18.1, NCC#168) ──

    private static SharedPreferences specPrefs(Context context) {
        return context.getSharedPreferences(SPECS_PREFS, Context.MODE_PRIVATE);
    }

    /** v1.18.1 (NCC#168) — the extras of an alarm intent (as schedule() and
     *  the receiver's re-arm build it), as JSON; "at" is EXTRA_AT, the instant
     *  it is set for. intentFromSpec is the inverse. Absent extras stay
     *  absent, so the rebuilt intent carries exactly the extras the original
     *  did. */
    static JSONObject specFromIntent(Intent intent) {
        JSONObject spec = new JSONObject();
        try {
            spec.put("id", intent.getIntExtra(EXTRA_ID, 0));
            spec.put("at", intent.getLongExtra(EXTRA_AT, 0L));
            putIfSet(spec, "title", intent.getStringExtra(EXTRA_TITLE));
            putIfSet(spec, "body", intent.getStringExtra(EXTRA_BODY));
            putIfSet(spec, "channelId", intent.getStringExtra(EXTRA_CHANNEL_ID));
            putIfSet(spec, "route", intent.getStringExtra(EXTRA_ROUTE));
            putIfSet(spec, "actionsJson", intent.getStringExtra(EXTRA_ACTIONS_JSON));
            String every = intent.getStringExtra(EXTRA_EVERY);
            if (every != null) {
                spec.put("every", every);
                spec.put("hour", intent.getIntExtra(EXTRA_HOUR, -1));
                spec.put("minute", intent.getIntExtra(EXTRA_MINUTE, -1));
                spec.put("weekday", intent.getIntExtra(EXTRA_WEEKDAY, -1));
            }
        } catch (JSONException ignored) { }
        return spec;
    }

    private static void putIfSet(JSONObject spec, String key, String value) throws JSONException {
        if (value != null) spec.put(key, value);
    }

    /** v1.18.1 (NCC#168) — a fresh intent for NotificationAlarmReceiver (no
     *  action, data or categories, like schedule() and cancel() build) with
     *  the spec's extras. `at` goes into EXTRA_AT as stored, even when the
     *  alarm is set for another instant, so the fire still matches the spec. */
    static Intent intentFromSpec(Context context, int id, JSONObject spec) {
        Intent intent = new Intent(context, NotificationAlarmReceiver.class);
        intent.putExtra(EXTRA_ID, id);
        intent.putExtra(EXTRA_AT, spec.optLong("at", 0L));
        putExtraIfSet(intent, EXTRA_TITLE, spec, "title");
        putExtraIfSet(intent, EXTRA_BODY, spec, "body");
        putExtraIfSet(intent, EXTRA_CHANNEL_ID, spec, "channelId");
        putExtraIfSet(intent, EXTRA_ROUTE, spec, "route");
        putExtraIfSet(intent, EXTRA_ACTIONS_JSON, spec, "actionsJson");
        String every = spec.optString("every", "");
        if (!every.isEmpty()) {
            intent.putExtra(EXTRA_EVERY, every);
            intent.putExtra(EXTRA_HOUR, spec.optInt("hour", -1));
            intent.putExtra(EXTRA_MINUTE, spec.optInt("minute", -1));
            if ("week".equals(every)) intent.putExtra(EXTRA_WEEKDAY, spec.optInt("weekday", -1));
        }
        return intent;
    }

    private static void putExtraIfSet(Intent intent, String extra, JSONObject spec, String key) {
        if (spec.has(key)) intent.putExtra(extra, spec.optString(key, ""));
    }

    /** v1.18.1 (NCC#168) — set an alarm and store its spec as one step, so
     *  the stored specs always mirror the alarms that are set: schedule(), the
     *  receiver's daily/weekly re-arm and the boot re-arm all come through
     *  here, and cancel() undoes both under the same lock. The spec's "at" is
     *  the intent's EXTRA_AT, which the caller sets; `armAt` is when the alarm
     *  goes off (the same, except for a reminder the boot re-arm fires late). */
    static void armAlarm(Context context, AlarmManager am, int id, Intent intent, long armAt) {
        String json = specFromIntent(intent).toString();
        synchronized (SPECS_LOCK) {
            setAlarm(am, armAt, alarmPendingIntent(context, id, intent));
            specPrefs(context).edit().putString(String.valueOf(id), json).commit();
        }
    }

    /** v1.18.1 (NCC#168) — cancel an alarm and forget its spec, so a
     *  cancelled reminder cannot come back at boot. */
    static void cancelAlarm(Context context, AlarmManager am, int id) {
        synchronized (SPECS_LOCK) {
            Intent intent = new Intent(context, NotificationAlarmReceiver.class);
            PendingIntent pi = PendingIntent.getBroadcast(
                context,
                id,
                intent,
                PendingIntent.FLAG_NO_CREATE | PendingIntent.FLAG_IMMUTABLE
            );
            if (pi != null && am != null) am.cancel(pi);
            specPrefs(context).edit().remove(String.valueOf(id)).commit();
        }
    }

    /** v1.18.1 (NCC#168) — a one-shot fired: forget its spec, unless a newer
     *  schedule() under the same id has replaced it since (its "at" differs
     *  from the fired intent's EXTRA_AT). An intent without EXTRA_AT is from
     *  an alarm set before this version, which never had a spec of its own. */
    static void forgetFiredOneShot(Context context, Intent fired) {
        int id = fired.getIntExtra(EXTRA_ID, 0);
        long firedAt = fired.getLongExtra(EXTRA_AT, -1L);
        if (firedAt < 0) return;
        String key = String.valueOf(id);
        synchronized (SPECS_LOCK) {
            SharedPreferences sp = specPrefs(context);
            JSONObject spec = parseSpec(sp.getString(key, null));
            if (spec == null || spec.optLong("at", 0L) != firedAt) return;
            sp.edit().remove(key).commit();
        }
    }

    static JSONObject parseSpec(String raw) {
        if (raw == null) return null;
        try {
            return new JSONObject(raw);
        } catch (JSONException e) {
            return null;
        }
    }

    /** v1.18.1 (NCC#168) — every stored spec by id. Unreadable entries are
     *  removed. Callers that act on the result hold SPECS_LOCK around both. */
    static Map<Integer, JSONObject> readSpecs(Context context) {
        Map<Integer, JSONObject> out = new HashMap<>();
        synchronized (SPECS_LOCK) {
            SharedPreferences sp = specPrefs(context);
            SharedPreferences.Editor drop = null;
            for (Map.Entry<String, ?> e : sp.getAll().entrySet()) {
                Object v = e.getValue();
                JSONObject spec = v instanceof String ? parseSpec((String) v) : null;
                Integer id = null;
                try {
                    id = Integer.valueOf(e.getKey());
                } catch (NumberFormatException ignored) { }
                if (spec == null || id == null) {
                    if (drop == null) drop = sp.edit();
                    drop.remove(e.getKey());
                    continue;
                }
                out.put(id, spec);
            }
            if (drop != null) drop.commit();
        }
        return out;
    }

    @PluginMethod
    public void getPending(PluginCall call) {
        JSArray ids = new JSArray();
        for (Integer id : readTrackedIds()) ids.put(id);
        JSObject result = new JSObject();
        result.put("ids", ids);
        call.resolve(result);
    }

    // ─── Tracked-ID storage ─────────────────────────────────────────────

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private Set<Integer> readTrackedIds() {
        Set<Integer> out = new HashSet<>();
        String raw = prefs().getString(KEY_SCHEDULED_IDS, "[]");
        try {
            JSONObject wrap = new JSONObject("{\"ids\":" + raw + "}");
            org.json.JSONArray arr = wrap.getJSONArray("ids");
            for (int i = 0; i < arr.length(); i++) out.add(arr.getInt(i));
        } catch (Exception ignored) { }
        return out;
    }

    private void writeTrackedIds(Set<Integer> set) {
        org.json.JSONArray arr = new org.json.JSONArray();
        for (Integer id : set) arr.put(id);
        prefs().edit().putString(KEY_SCHEDULED_IDS, arr.toString()).apply();
    }

    private void addTrackedId(int id) {
        Set<Integer> set = readTrackedIds();
        set.add(id);
        writeTrackedIds(set);
    }

    private void removeTrackedId(int id) {
        Set<Integer> set = readTrackedIds();
        if (set.remove(id)) writeTrackedIds(set);
    }

    // ─── Tap routing — broadcast a JS event ─────────────────────────────
    //
    // Called from MainActivity after a notification is tapped, and from
    // NotificationActionReceiver after an action button is tapped. We emit a
    // Capacitor event that JS subscribes to, and always queue the tap or
    // action as well (v1.3.1 BUG-14): on a cold start the plugin is loaded
    // BEFORE the JS that registers the listener runs, so the event fires into
    // a void, and JS drains the queue (consumePendingTap / consumePendingAction)
    // right after addListener succeeds.
    //
    // v1.18.1 (NCC#169) — the queue is persisted (see KEY_PENDING_ACTIONS)
    // instead of one static slot in memory, and an entry stays until JS
    // acknowledges it (ackPendingTaps / ackPendingActions). The live event
    // carries the entry's "seq", so JS can tell the event and the queued
    // copy are the same tap and apply it once.

    public static void deliverTap(Context context, NexusNotificationsPlugin instance, String route) {
        JSONObject entry = new JSONObject();
        try {
            entry.put("route", route == null ? "" : route);
        } catch (JSONException ignored) { }
        long seq = enqueuePending(context, KEY_PENDING_TAPS, entry, null);
        if (instance != null) {
            JSObject ev = new JSObject();
            ev.put("route", route == null ? "" : route);
            ev.put("seq", seq);
            instance.notifyListeners("notificationTap", ev);
        }
    }

    /** Mirror of deliverTap for action-button taps. Forwards the action id
     *  plus optional route + extra payload to the JS `notificationAction`
     *  event listener. Always queued (see deliverTap for why); notifyListeners
     *  is best-effort. JS drains via consumePendingAction on mount. */
    public static void deliverAction(
        Context context,
        NexusNotificationsPlugin instance,
        int notifId,
        String actionId,
        String route,
        String extraJson
    ) {
        String a = actionId == null ? "" : actionId;
        String r = route == null ? "" : route;
        String x = extraJson == null ? "" : extraJson;
        JSONObject entry = new JSONObject();
        try {
            entry.put("actionId", a);
            entry.put("route", r);
            entry.put("extraJson", x);
        } catch (JSONException ignored) { }
        // v1.18.1 (NCC#169) — the same button on the same notification, still
        // waiting, is one action (a double tap before the shade closes).
        String sameAs = notifId + "|" + a + "|" + x;
        long seq = enqueuePending(context, KEY_PENDING_ACTIONS, entry, sameAs);
        if (instance != null) {
            JSObject ev = new JSObject();
            ev.put("actionId", a);
            ev.put("route", r);
            ev.put("extraJson", x);
            ev.put("seq", seq);
            instance.notifyListeners("notificationAction", ev);
        }
    }

    // ─── Pending queue storage (v1.18.1, NCC#169) ───────────────────────

    private static SharedPreferences sharedPrefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static JSONArray readQueue(SharedPreferences sp, String queueKey) {
        String raw = sp.getString(queueKey, "[]");
        try {
            return new JSONArray(raw == null ? "[]" : raw);
        } catch (JSONException e) {
            return new JSONArray();
        }
    }

    /** Appends `entry` to a queue, oldest dropped past PENDING_MAX, and
     *  returns its seq. With `sameAs`, an entry still queued under the same
     *  key is kept instead and its seq returned. commit(), not apply(): the
     *  process can be killed as soon as the receiver returns. -1 when it
     *  could not be queued. */
    private static long enqueuePending(Context context, String queueKey, JSONObject entry, String sameAs) {
        synchronized (PENDING_LOCK) {
            SharedPreferences sp = sharedPrefs(context);
            JSONArray queue = readQueue(sp, queueKey);
            if (sameAs != null) {
                for (int i = 0; i < queue.length(); i++) {
                    JSONObject q = queue.optJSONObject(i);
                    if (q != null && sameAs.equals(q.optString("key", null))) {
                        return q.optLong("seq", -1L);
                    }
                }
            }
            long seq = sp.getLong(KEY_PENDING_SEQ, 0L) + 1L;
            try {
                entry.put("seq", seq);
                entry.put("at", System.currentTimeMillis());
                if (sameAs != null) entry.put("key", sameAs);
            } catch (JSONException e) {
                return -1L;
            }
            JSONArray next = new JSONArray();
            int start = Math.max(0, queue.length() - (PENDING_MAX - 1));
            for (int i = start; i < queue.length(); i++) {
                JSONObject q = queue.optJSONObject(i);
                if (q != null) next.put(q);
            }
            next.put(entry);
            boolean saved = sp.edit()
                .putLong(KEY_PENDING_SEQ, seq)
                .putString(queueKey, next.toString())
                .commit();
            // Not saved: nothing is queued, so the live event goes without a
            // seq (JS applies it, acknowledges nothing), and the seq is not
            // handed out for an entry that does not exist.
            return saved ? seq : -1L;
        }
    }

    /** Every entry of a queue, oldest first. Leaves the queue as it is. */
    private static JSArray peekPending(Context context, String queueKey) {
        synchronized (PENDING_LOCK) {
            JSONArray queue = readQueue(sharedPrefs(context), queueKey);
            JSArray out = new JSArray();
            for (int i = 0; i < queue.length(); i++) {
                JSONObject q = queue.optJSONObject(i);
                if (q != null) out.put(q);
            }
            return out;
        }
    }

    /** Removes the entries whose seq JS acknowledged. */
    private static void ackPending(Context context, String queueKey, Set<Long> seqs) {
        if (seqs.isEmpty()) return;
        synchronized (PENDING_LOCK) {
            SharedPreferences sp = sharedPrefs(context);
            JSONArray queue = readQueue(sp, queueKey);
            JSONArray next = new JSONArray();
            for (int i = 0; i < queue.length(); i++) {
                JSONObject q = queue.optJSONObject(i);
                if (q == null || seqs.contains(q.optLong("seq", -1L))) continue;
                next.put(q);
            }
            sp.edit().putString(queueKey, next.toString()).commit();
        }
    }

    private static Set<Long> seqsOf(PluginCall call) {
        Set<Long> out = new HashSet<>();
        JSArray arr = call.getArray("seqs");
        if (arr == null) return out;
        for (int i = 0; i < arr.length(); i++) {
            long seq = arr.optLong(i, -1L);
            if (seq >= 0) out.add(seq);
        }
        return out;
    }

    // ─── Cold-start drain — JS pulls the queued taps / actions ──────────
    //
    // v1.3.1 BUG-14 — On a cold-start launched from a notification tap,
    // notifyListeners fires before the JS useEffect registers its handler,
    // so the event is dropped. JS calls these methods AFTER addListener
    // resolves to harvest the queue and complete the navigation.
    //
    // v1.18.1 (NCC#169) — these return the whole queue ("taps" / "actions",
    // oldest first) and no longer clear it: JS acknowledges what it applied
    // with ackPendingTaps / ackPendingActions. The old single-entry fields
    // stay for compatibility: the newest tap's route (the old slot kept the
    // latest), and the oldest action's fields.

    @PluginMethod
    public void consumePendingTap(PluginCall call) {
        JSArray taps = peekPending(getContext(), KEY_PENDING_TAPS);
        JSONObject newest = taps.length() > 0 ? taps.optJSONObject(taps.length() - 1) : null;
        JSObject result = new JSObject();
        result.put("route", newest == null ? "" : newest.optString("route", ""));
        result.put("taps", taps);
        call.resolve(result);
    }

    @PluginMethod
    public void consumePendingAction(PluginCall call) {
        JSArray actions = peekPending(getContext(), KEY_PENDING_ACTIONS);
        JSONObject oldest = actions.length() > 0 ? actions.optJSONObject(0) : null;
        JSObject result = new JSObject();
        result.put("actionId", oldest == null ? "" : oldest.optString("actionId", ""));
        result.put("route", oldest == null ? "" : oldest.optString("route", ""));
        result.put("extraJson", oldest == null ? "" : oldest.optString("extraJson", ""));
        result.put("actions", actions);
        call.resolve(result);
    }

    /** v1.18.1 (NCC#169) — JS took these taps: { seqs: number[] }. */
    @PluginMethod
    public void ackPendingTaps(PluginCall call) {
        ackPending(getContext(), KEY_PENDING_TAPS, seqsOf(call));
        call.resolve();
    }

    /** v1.18.1 (NCC#169) — JS applied these actions: { seqs: number[] }. */
    @PluginMethod
    public void ackPendingActions(PluginCall call) {
        ackPending(getContext(), KEY_PENDING_ACTIONS, seqsOf(call));
        call.resolve();
    }

    @Override
    public void load() {
        super.load();
        sInstance = this;
        // v1.18.1 (NCC#143): no replay here. load() runs before JS has
        // registered any listener, so a replay went nowhere, and it then
        // cleared the buffer, so the JS drain (consumePendingTap /
        // consumePendingAction, called right after addListener) found
        // nothing: a "Mark done" tapped while the app was closed was lost.
        // The queue is left for that drain (persisted since NCC#169).
    }
}
