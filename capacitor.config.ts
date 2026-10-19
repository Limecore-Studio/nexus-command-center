import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.limecore.nexus',
  appName: 'Nexus Command Center',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
  },
  android: {
    backgroundColor: '#0B0C0E',
  },
  plugins: {
    // CapacitorHttp's global fetch/XHR patch is OFF because it interferes with
    // Supabase JS — specifically it appears to drop or mangle the
    // `Authorization: Bearer <jwt>` header on /rest/v1 calls, causing RLS to
    // reject every write (auth.uid() = null vs. user_id check fails).
    //
    // We still install the plugin so we can call `CapacitorHttp.request()`
    // directly for the one endpoint that needs CORS-bypassed native HTTP:
    // Yahoo Finance's chart API. See src/api/yahoo.ts.
    CapacitorHttp: {
      enabled: false,
    },
    // Capacitor 8's core System Bars plugin defaults to style DEFAULT, which
    // follows the DEVICE's light/dark mode: on a phone in light mode it drew
    // dark status-bar icons over NCC's dark UI, all but invisible (NCC#49,
    // checked on an Android 17 emulator against the Capacitor 7 build, which
    // showed light icons). Every NCC theme is dark (free #0B0C0E, Rack
    // #1C1D1F), so the content is always light. insetsHandling stays at its
    // default ('css'); the layout was identical to Capacitor 7's.
    SystemBars: {
      style: 'DARK',
    },
  },
};

export default config;
