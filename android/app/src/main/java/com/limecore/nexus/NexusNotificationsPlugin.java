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

import org.json.JSONObject;

import java.util.HashSet;
import java.util.Iterator;
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

        // FLAG_UPDATE_CURRENT so re-scheduling with the same ID replaces
        // the existing alarm cleanly. FLAG_IMMUTABLE is required on
        // Android 12+ — Capacitor's min target is well above that.
        PendingIntent pi = PendingIntent.getBroadcast(
            getContext(),
            id,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        AlarmManager am = (AlarmManager) getContext().getSystemService(Context.ALARM_SERVICE);
        if (am == null) {
            call.reject("AlarmManager unavailable");
            return;
        }

        // RTC_WAKEUP wakes the device if asleep — necessary for time-of-day
        // notifications like the 4:05pm market-close recap. AllowWhileIdle
        // adds Doze-mode tolerance (within OS-imposed quota) so the alarm
        // still fires during long idle stretches; without it, doze can
        // defer the alarm by hours.
        //
        // v1.19 — NCC#137: setAndAllowWhileIdle is INEXACT. Android may
        // deliver it well after fireAt (a large share of the lead time, up
        // to about an hour), so a 09:00 task reminder could land at 09:40.
        // The exact variant fires on the minute; USE_EXACT_ALARM (manifest)
        // grants it on API 33+, SCHEDULE_EXACT_ALARM on 31-32. If the user
        // revokes it in system settings, fall back to the inexact call
        // rather than throwing a SecurityException.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S || am.canScheduleExactAlarms()) {
            am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, fireAt, pi);
        } else {
            am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, fireAt, pi);
        }

        // Track the ID so cancelAll / getPending can enumerate it later.
        addTrackedId(id);

        JSObject result = new JSObject();
        result.put("id", id);
        result.put("at", fireAt);
        call.resolve(result);
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
                Intent intent = new Intent(getContext(), NotificationAlarmReceiver.class);
                PendingIntent pi = PendingIntent.getBroadcast(
                    getContext(),
                    id,
                    intent,
                    PendingIntent.FLAG_NO_CREATE | PendingIntent.FLAG_IMMUTABLE
                );
                if (pi != null && am != null) am.cancel(pi);
                if (nm != null) nm.cancel(id); // also drop any already-posted notif
                removeTrackedId(id);
            }
        } catch (Exception e) {
            call.reject("Cancel failed: " + e.getMessage());
            return;
        }
        call.resolve();
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
    // Called from the receiver via static helper after the notification is
    // tapped. We emit a Capacitor event that JS subscribes to. If the plugin
    // instance hasn't been initialized yet (cold start from a tap), we
    // buffer the event so the first listener registration replays it.
    //
    // The same pattern applies to action-button taps (deliverAction below)
    // — both share the cold-start buffering since a user can launch the
    // app fresh from either the notification body or an action button.

    private static String pendingTapRoute = null;

    // Action cold-start buffer. Stores the single most-recent action so the
    // JS listener can re-emit on first subscription. Coalescing to one entry
    // is fine — if the user taps two action buttons before opening the app,
    // only the latter matters (and Android dismisses tapped notifications
    // before allowing a second tap on the same one).
    private static String pendingActionId = null;
    private static String pendingActionRoute = null;
    private static String pendingActionExtraJson = null;

    public static void deliverTap(NexusNotificationsPlugin instance, String route) {
        // v1.3.1 BUG-14 — always buffer. notifyListeners is best-effort because
        // on cold start the plugin is loaded (sInstance != null) BEFORE the JS
        // useEffect that registers the listener runs, so the event would fire
        // into a void. JS calls consumePendingTap() right after addListener
        // succeeds to drain whatever the cold-start path left behind.
        pendingTapRoute = route;
        if (instance != null) {
            JSObject ev = new JSObject();
            ev.put("route", route == null ? "" : route);
            instance.notifyListeners("notificationTap", ev);
        }
    }

    /** Mirror of deliverTap for action-button taps. Forwards the action id
     *  plus optional route + extra payload to the JS `notificationAction`
     *  event listener. Always buffered (see deliverTap for why); notifyListeners
     *  is best-effort. JS drains via consumePendingAction on mount. */
    public static void deliverAction(
        NexusNotificationsPlugin instance,
        String actionId,
        String route,
        String extraJson
    ) {
        pendingActionId = actionId;
        pendingActionRoute = route;
        pendingActionExtraJson = extraJson;
        if (instance != null) {
            JSObject ev = new JSObject();
            ev.put("actionId", actionId == null ? "" : actionId);
            ev.put("route", route == null ? "" : route);
            ev.put("extraJson", extraJson == null ? "" : extraJson);
            instance.notifyListeners("notificationAction", ev);
        }
    }

    // ─── Cold-start drain — JS pulls the buffered tap / action ──────────
    //
    // v1.3.1 BUG-14 — On a cold-start launched from a notification tap,
    // notifyListeners fires before the JS useEffect registers its handler,
    // so the event is dropped. JS calls these methods AFTER addListener
    // resolves to harvest the buffer and complete the navigation. Warm-start
    // taps still arrive via notifyListeners (the bridge already has a
    // subscribed listener), AND also write the buffer — the buffer is then
    // immediately drained by the same call, so the duplicate is a no-op
    // (react-router navigate to the same route is idempotent).

    @PluginMethod
    public void consumePendingTap(PluginCall call) {
        JSObject result = new JSObject();
        result.put("route", pendingTapRoute == null ? "" : pendingTapRoute);
        pendingTapRoute = null;
        call.resolve(result);
    }

    @PluginMethod
    public void consumePendingAction(PluginCall call) {
        JSObject result = new JSObject();
        result.put("actionId", pendingActionId == null ? "" : pendingActionId);
        result.put("route", pendingActionRoute == null ? "" : pendingActionRoute);
        result.put("extraJson", pendingActionExtraJson == null ? "" : pendingActionExtraJson);
        pendingActionId = null;
        pendingActionRoute = null;
        pendingActionExtraJson = null;
        call.resolve(result);
    }

    @Override
    public void load() {
        super.load();
        sInstance = this;
        // Replay any tap that happened before JS subscribed (cold-start case).
        if (pendingTapRoute != null) {
            JSObject ev = new JSObject();
            ev.put("route", pendingTapRoute);
            notifyListeners("notificationTap", ev);
            pendingTapRoute = null;
        }
        // Same replay for a buffered action-button tap.
        if (pendingActionId != null) {
            JSObject ev = new JSObject();
            ev.put("actionId", pendingActionId);
            ev.put("route", pendingActionRoute == null ? "" : pendingActionRoute);
            ev.put("extraJson", pendingActionExtraJson == null ? "" : pendingActionExtraJson);
            notifyListeners("notificationAction", ev);
            pendingActionId = null;
            pendingActionRoute = null;
            pendingActionExtraJson = null;
        }
    }
}
