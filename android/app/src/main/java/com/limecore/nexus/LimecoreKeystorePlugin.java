package com.limecore.nexus;

// v1.4 — Android Keystore wrapper for sensitive at-rest blobs.
//
// Backs the migration of NCC's PIN hash storage from plaintext
// SharedPreferences (Capacitor Preferences) into AKS-encrypted blobs.
// Future callers: Dexie database encryption key, OAuth refresh tokens
// before SSO publish (defense-in-depth on top of MODE_PRIVATE).
//
// KEY MATERIAL
// ───────────────────────────────────────────────────────────────────────────
// AES-256 keys generated via KeyGenParameterSpec with:
//   - Block mode  GCM (authenticated encryption — detects tampering)
//   - Padding     NONE (GCM doesn't need padding)
//   - User auth   NOT required (we encrypt on background flows; user-auth-
//                 gated keys are a separate concern for biometric prompts)
//
// The key NEVER leaves the secure hardware element (on devices with one) —
// non-exportable by KeyStore contract. We pass plaintext IN and get
// ciphertext OUT through the cipher object, but the raw key bytes are
// inaccessible to user-space, root, or memory dumps.
//
// SERIALIZATION
// ───────────────────────────────────────────────────────────────────────────
// IV is 12 bytes (GCM standard), chosen by the keystore per encrypt. Returned
// alongside ciphertext as base64 strings. Caller's responsibility to
// persist both together; decrypt requires both.
//
// JS interface (see keystorePlugin.ts):
//   getOrCreateKey({ alias }) → { created: boolean }
//   encrypt({ alias, plaintext }) → { ciphertext, iv }      (both base64)
//   decrypt({ alias, ciphertext, iv }) → { plaintext }       (utf-8 string)
//   hasKey({ alias }) → { exists: boolean }
//   deleteKey({ alias }) → void
//
// All methods reject with a descriptive message on failure. JS callers
// should wrap in try/catch and fall back to a non-encrypted storage path
// (e.g. older Android versions where KeyStore is partial or buggy).

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.KeyStore.SecretKeyEntry;
import java.util.Base64;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

@CapacitorPlugin(name = "LimecoreKeystore")
public class LimecoreKeystorePlugin extends Plugin {

    private static final String KEYSTORE_PROVIDER = "AndroidKeyStore";
    private static final String TRANSFORMATION = "AES/GCM/NoPadding";
    private static final int GCM_TAG_BITS = 128;
    private static final int IV_BYTES = 12;

    @PluginMethod
    public void getOrCreateKey(PluginCall call) {
        String alias = call.getString("alias");
        if (alias == null || alias.isEmpty()) {
            call.reject("alias is required");
            return;
        }
        try {
            KeyStore ks = KeyStore.getInstance(KEYSTORE_PROVIDER);
            ks.load(null);
            if (ks.containsAlias(alias)) {
                JSObject r = new JSObject();
                r.put("created", false);
                call.resolve(r);
                return;
            }
            KeyGenerator kg = KeyGenerator.getInstance(
                KeyProperties.KEY_ALGORITHM_AES, KEYSTORE_PROVIDER
            );
            KeyGenParameterSpec spec = new KeyGenParameterSpec.Builder(
                alias,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                // setRandomizedEncryptionRequired(true) is the default: the
                // keystore picks a fresh IV per encrypt (see encrypt()).
                .build();
            kg.init(spec);
            kg.generateKey();
            JSObject r = new JSObject();
            r.put("created", true);
            call.resolve(r);
        } catch (Exception e) {
            call.reject("getOrCreateKey failed: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void hasKey(PluginCall call) {
        String alias = call.getString("alias");
        if (alias == null || alias.isEmpty()) {
            call.reject("alias is required");
            return;
        }
        try {
            KeyStore ks = KeyStore.getInstance(KEYSTORE_PROVIDER);
            ks.load(null);
            JSObject r = new JSObject();
            r.put("exists", ks.containsAlias(alias));
            call.resolve(r);
        } catch (Exception e) {
            call.reject("hasKey failed: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void encrypt(PluginCall call) {
        String alias = call.getString("alias");
        String plaintext = call.getString("plaintext");
        if (alias == null || alias.isEmpty()) {
            call.reject("alias is required");
            return;
        }
        if (plaintext == null) {
            // Empty-string plaintext is legitimate — encrypt() it. Null is not.
            call.reject("plaintext is required (use empty string for empty data)");
            return;
        }
        try {
            SecretKey key = loadKey(alias);
            if (key == null) {
                call.reject("No key for alias: " + alias);
                return;
            }
            // The keystore chooses the IV. Keys are created with
            // setRandomizedEncryptionRequired(true) (the default), and such a
            // key REFUSES a caller-provided IV on encrypt ("Caller-provided IV
            // not permitted"). This method used to pass its own random IV, so
            // encrypt always failed. Init with no parameter
            // spec, then read back the fresh 12-byte IV the keystore picked.
            // Existing keys need no rotation; decrypt is unchanged (passing
            // the stored IV is allowed when decrypting).
            Cipher cipher = Cipher.getInstance(TRANSFORMATION);
            cipher.init(Cipher.ENCRYPT_MODE, key);
            byte[] iv = cipher.getIV();
            if (iv == null || iv.length != IV_BYTES) {
                call.reject("encrypt failed: unexpected IV length " + (iv == null ? "null" : iv.length));
                return;
            }
            byte[] ct = cipher.doFinal(plaintext.getBytes(StandardCharsets.UTF_8));
            JSObject r = new JSObject();
            r.put("ciphertext", Base64.getEncoder().encodeToString(ct));
            r.put("iv", Base64.getEncoder().encodeToString(iv));
            call.resolve(r);
        } catch (Exception e) {
            call.reject("encrypt failed: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void decrypt(PluginCall call) {
        String alias = call.getString("alias");
        String ciphertextB64 = call.getString("ciphertext");
        String ivB64 = call.getString("iv");
        if (alias == null || ciphertextB64 == null || ivB64 == null) {
            call.reject("alias, ciphertext, iv are all required");
            return;
        }
        try {
            SecretKey key = loadKey(alias);
            if (key == null) {
                call.reject("No key for alias: " + alias);
                return;
            }
            byte[] iv = Base64.getDecoder().decode(ivB64);
            byte[] ct = Base64.getDecoder().decode(ciphertextB64);
            Cipher cipher = Cipher.getInstance(TRANSFORMATION);
            cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(GCM_TAG_BITS, iv));
            byte[] pt = cipher.doFinal(ct);
            JSObject r = new JSObject();
            r.put("plaintext", new String(pt, StandardCharsets.UTF_8));
            call.resolve(r);
        } catch (Exception e) {
            // GCM auth failure surfaces here — likely tamper, IV mismatch,
            // or key rotation. Caller should treat it as "data lost,
            // re-initialize."
            call.reject("decrypt failed: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void deleteKey(PluginCall call) {
        String alias = call.getString("alias");
        if (alias == null || alias.isEmpty()) {
            call.reject("alias is required");
            return;
        }
        try {
            KeyStore ks = KeyStore.getInstance(KEYSTORE_PROVIDER);
            ks.load(null);
            if (ks.containsAlias(alias)) ks.deleteEntry(alias);
            call.resolve();
        } catch (Exception e) {
            call.reject("deleteKey failed: " + e.getMessage(), e);
        }
    }

    private SecretKey loadKey(String alias) throws Exception {
        KeyStore ks = KeyStore.getInstance(KEYSTORE_PROVIDER);
        ks.load(null);
        KeyStore.Entry entry = ks.getEntry(alias, null);
        if (entry instanceof SecretKeyEntry) {
            return ((SecretKeyEntry) entry).getSecretKey();
        }
        return null;
    }
}
