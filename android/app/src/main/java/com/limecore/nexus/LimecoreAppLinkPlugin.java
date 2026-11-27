package com.limecore.nexus;

// v1.22 (limecore#131) — open a screen of a sibling suite app (StudyDesk,
// LimeLog) by its route deep link, or report that the app is not installed so
// the caller can fall back to its F-Droid page.
//
// Only the two sibling packages are accepted, and the intent is pinned to the
// package (setPackage), so a link can never be handed to some other app that
// registered the same scheme. The link carries a route and at most an id,
// never data. Android 11+ needs the <queries> entries in the manifest for
// resolveActivity to see the two packages.
//
// JS interface (see src/lib/suiteApps.ts):
//   open({ url, packageName }) -> { opened: boolean }

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;

@CapacitorPlugin(name = "LimecoreAppLink")
public class LimecoreAppLinkPlugin extends Plugin {

    private static final Set<String> SIBLINGS =
        new HashSet<>(Arrays.asList("com.StudyDesk.app", "com.limecore.workouttracker"));

    @PluginMethod
    public void open(PluginCall call) {
        String url = call.getString("url");
        String pkg = call.getString("packageName");
        if (url == null || pkg == null || !SIBLINGS.contains(pkg)) {
            call.reject("Not a suite app link");
            return;
        }
        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
        intent.setPackage(pkg);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);

        JSObject result = new JSObject();
        if (intent.resolveActivity(getContext().getPackageManager()) == null) {
            result.put("opened", false);
            call.resolve(result);
            return;
        }
        try {
            getContext().startActivity(intent);
            result.put("opened", true);
        } catch (ActivityNotFoundException e) {
            result.put("opened", false);
        }
        call.resolve(result);
    }
}
