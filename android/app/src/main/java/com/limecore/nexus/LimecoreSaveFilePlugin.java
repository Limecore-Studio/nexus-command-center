package com.limecore.nexus;

// v1.21.1 (limecore#103) — save a text file where the user chooses.
//
// An Android WebView ignores <a download>, so the data export used to report
// "Saved" while nothing was written. This opens the system "create document"
// picker (ACTION_CREATE_DOCUMENT): the user picks the folder and the name, and
// the app writes through the returned content URI. No storage permission and
// no new dependency.
//
// JS interface (see src/lib/saveFile.ts):
//   save({ name, data, mimeType? }) -> { saved: boolean }
//     saved=false: the user cancelled the picker. Rejects when the write fails.

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

@CapacitorPlugin(name = "LimecoreSaveFile")
public class LimecoreSaveFilePlugin extends Plugin {

    @PluginMethod
    public void save(PluginCall call) {
        String name = call.getString("name");
        String data = call.getString("data");
        if (name == null || name.isEmpty() || data == null) {
            call.reject("name and data are required");
            return;
        }
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(call.getString("mimeType", "application/json"));
        intent.putExtra(Intent.EXTRA_TITLE, name);
        startActivityForResult(call, intent, "onDocumentPicked");
    }

    @ActivityCallback
    private void onDocumentPicked(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent picked = result.getData();
        Uri uri = picked != null ? picked.getData() : null;
        if (result.getResultCode() != Activity.RESULT_OK || uri == null) {
            JSObject out = new JSObject();
            out.put("saved", false);
            call.resolve(out);
            return;
        }
        final String data = call.getString("data", "");
        // Off the main thread: an export can be several megabytes.
        new Thread(() -> {
            // "wt" truncates when the user picks an existing file to replace.
            try (OutputStream os = getContext().getContentResolver().openOutputStream(uri, "wt")) {
                if (os == null) throw new java.io.IOException("no output stream for the chosen file");
                os.write(data.getBytes(StandardCharsets.UTF_8));
                os.flush();
                JSObject out = new JSObject();
                out.put("saved", true);
                call.resolve(out);
            } catch (Exception e) {
                call.reject("Could not write the file: " + e.getMessage());
            }
        }).start();
    }
}
