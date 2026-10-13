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
        // failure further down cannot stop tomorrow's.
        rearmIfDaily(context, intent);

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
        // they're already unique within our 1000-5999 range.
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
     *  opened again. When this alarm fires, schedule the same intent for the
     *  same LOCAL time on the next day (Calendar keeps the wall-clock time
     *  across a DST change; adding 24 hours would not). Same request code and
     *  component as the original, so cancel() in the plugin still cancels it.
     *  Not covered: a reboot or force-stop clears all alarms until the app
     *  is opened again (no boot receiver; the owner's call, see NCC#138). */
    private static void rearmIfDaily(Context context, Intent intent) {
        if (!"day".equals(intent.getStringExtra(NexusNotificationsPlugin.EXTRA_EVERY))) return;
        int id = intent.getIntExtra(NexusNotificationsPlugin.EXTRA_ID, 0);
        long at = intent.getLongExtra(NexusNotificationsPlugin.EXTRA_AT, System.currentTimeMillis());
        Calendar next = Calendar.getInstance();
        next.setTimeInMillis(at);
        long now = System.currentTimeMillis();
        do {
            next.add(Calendar.DAY_OF_MONTH, 1);
        } while (next.getTimeInMillis() <= now);

        Intent again = new Intent(intent);
        again.putExtra(NexusNotificationsPlugin.EXTRA_AT, next.getTimeInMillis());
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }
        PendingIntent pi = PendingIntent.getBroadcast(context, id, again, flags);
        AlarmManager am = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (am == null) {
            Log.w(TAG, "AlarmManager unavailable; daily reminder id=" + id + " not re-armed");
            return;
        }
        NexusNotificationsPlugin.setAlarm(am, next.getTimeInMillis(), pi);
    }
}
