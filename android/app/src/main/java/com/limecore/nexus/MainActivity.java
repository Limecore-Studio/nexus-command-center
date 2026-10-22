package com.limecore.nexus;

import android.content.Intent;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.PluginHandle;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Register the custom NexusNotifications plugin BEFORE super.onCreate
        // so the bridge picks it up during initial setup.
        registerPlugin(NexusNotificationsPlugin.class);
        // v1.4 — Android Keystore plugin for PIN hash encryption + future
        // Dexie at-rest encryption. Same pre-super registration pattern.
        registerPlugin(LimecoreKeystorePlugin.class);
        super.onCreate(savedInstanceState);
        handleNotificationTap(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleNotificationTap(intent);
    }

    // Pull the tap route (if any) out of an intent launched by a notification
    // and forward it to the plugin, which broadcasts a `notificationTap`
    // event to JS so the navigator can route. Safe to call with any intent
    // — no extra means no tap to deliver.
    private void handleNotificationTap(Intent intent) {
        if (intent == null) return;
        String route = intent.getStringExtra(NotificationAlarmReceiver.EXTRA_TAP_ROUTE);
        if (route == null || route.isEmpty()) return;
        // Find the live plugin instance through the bridge and deliver. The
        // bridge may not yet have a handle on first cold-start before
        // super.onCreate finishes, so be defensive: deliverTap handles a
        // null instance by queueing until the JS side subscribes (the queue
        // is persisted since v1.18.1, NCC#169, so it needs a Context).
        PluginHandle handle = getBridge().getPlugin("NexusNotifications");
        NexusNotificationsPlugin plugin = handle != null
            ? (NexusNotificationsPlugin) handle.getInstance()
            : null;
        NexusNotificationsPlugin.deliverTap(this, plugin, route);
        // Clear the extra so a config change (rotation, etc.) doesn't replay it.
        intent.removeExtra(NotificationAlarmReceiver.EXTRA_TAP_ROUTE);
    }
}
