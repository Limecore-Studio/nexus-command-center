// Electron shell for NCC's desktop edition. Wraps the existing static Vite
// build (dist/) — the same artifact already shipped as
// NexusCommandCenter-Desktop-1.9.0.zip and already proven live on the web —
// in a real installable Windows window rather than "download a zip, open
// index.html yourself."
//
// Serves dist/ through a custom `nexus://` scheme rather than file:// or a
// localhost HTTP server. vite.config.ts doesn't set `base`, so the production
// build emits root-absolute asset paths (`/assets/...`). Those break under
// file://, which resolves `/assets/...` from the filesystem root rather than
// the html file's directory. Changing `base` globally would risk the live web
// deployment (limecore.dev) and the GitHub Pages site instead — so the fix
// lives here, in the Electron-only wrapper, touching nothing shared with the
// web build.
//
// ── Why a custom scheme and not http://127.0.0.1 (v1.10, forced-logout bug) ──
// This previously ran a local static server on `server.listen(0, ...)`, which
// asks the OS for a RANDOM free port, and loaded `http://127.0.0.1:<port>/`.
// The page therefore had a different ORIGIN on every single launch, and
// localStorage — where supabase-js persists the session on non-Capacitor
// platforms — is partitioned per origin. So every launch opened an empty
// storage bucket, the stored session was unreachable, and the user had to sign
// in again. It looked like "my session expired"; nothing had expired at all,
// and the server-side evidence agrees: of the desktop sessions on the owner's
// account, not one was ever revoked — they were simply abandoned, four of them
// without a single token refresh.
//
// A fixed port would restore a stable origin but reintroduces the same class
// of bug the moment that port is taken and the code falls back to another one.
// A registered scheme has no port to collide, so the origin is stable by
// construction. `secure: true` also keeps the page a secure context, which
// supabase-js's PKCE flow needs for crypto.subtle.
//
// NOTE: `nexus://app/` is the app's web origin now. That is a stable origin for
// storage, but it is NOT usable as an OAuth redirect target: Supabase's
// allow-list takes http(s) URLs, so a custom scheme can never be entered there.
// v1.12 shipped with `OAUTH_REDIRECT_URL` resolving to it anyway, Supabase fell
// back to the project's Site URL, and desktop sign-in ended on the marketing
// site inside the app's own window. v1.12.1 replaces that with a fixed-port
// loopback listener (see `startAuthLoopback` below) and refuses to let the
// window leave this origin at all (see `hardenNavigation`).
'use strict';

const { app, BrowserWindow, ipcMain, protocol, net, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const { pathToFileURL } = require('node:url');
const { setupUpdates } = require('./updater.cjs');
const { createAuthState } = require('./authState.cjs');

const DIST_DIR = path.join(__dirname, '..', 'dist');
const ICON_PATH = path.join(__dirname, '..', 'resources', 'icon.ico');
const AUTH_PRELOAD = path.join(__dirname, 'auth-preload.cjs');

const SCHEME = 'nexus';
const APP_ORIGIN = `${SCHEME}://app`;

// Must run before app.whenReady(). `standard` gives the scheme normal URL
// parsing (host + path) so `nexus://app/assets/x.js` resolves the way the
// build's root-absolute paths expect; `secure` grants secure-context powers
// (crypto.subtle, and storage that isn't treated as third-party).
protocol.registerSchemesAsPrivileged([
  {
    scheme: SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);

// Verification-pass diagnostics (2026-08-14) — a packaged build launched
// three live processes with no visible window and no listening server, with
// nothing surfaced anywhere (packaged Electron apps have no attached
// console). This writes a plain-text log next to userData so a launch
// failure is actually inspectable instead of just "nothing happened."
const LOG_PATH = path.join(app.getPath('userData'), 'main.log');
function log(line) {
  try {
    fs.appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${line}\n`);
  } catch {
    // Logging must never be why the app fails to start.
  }
}
log(`app starting — __dirname=${__dirname} DIST_DIR=${DIST_DIR} exists=${fs.existsSync(DIST_DIR)}`);
process.on('uncaughtException', (err) => log(`UNCAUGHT EXCEPTION: ${err && err.stack}`));
process.on('unhandledRejection', (err) => log(`UNHANDLED REJECTION: ${err && err.stack}`));

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ico': 'image/x-icon',
};

// Resolve a request URL to a real file under dist/, with the same SPA
// fallback the old static server had: anything that isn't a real file serves
// index.html so React Router works exactly as it does on the live web build.
function resolveRequest(requestUrl) {
  const { pathname } = new URL(requestUrl);
  const filePath = path.join(DIST_DIR, decodeURIComponent(pathname));

  // Guard against path traversal escaping dist/. path.join has already
  // normalised away `..`, so this compares the resolved result.
  if (filePath !== DIST_DIR && !filePath.startsWith(DIST_DIR + path.sep)) return null;

  try {
    if (fs.statSync(filePath).isFile()) return filePath;
  } catch {
    // Falls through to the SPA entry point below.
  }
  return path.join(DIST_DIR, 'index.html');
}

function registerProtocolHandler() {
  protocol.handle(SCHEME, async (request) => {
    const filePath = resolveRequest(request.url);
    if (!filePath) return new Response('Forbidden', { status: 403 });

    const response = await net.fetch(pathToFileURL(filePath).toString());
    // Set Content-Type explicitly rather than trusting inference — a wrong or
    // missing type on the module scripts is a blank window with no error.
    return new Response(response.body, {
      status: 200,
      headers: {
        'Content-Type': MIME_TYPES[path.extname(filePath)] ?? 'application/octet-stream',
      },
    });
  });
}

let mainWindow = null;

// ── Off-origin navigation guard (v1.12.1, P0) ───────────────────────────────
//
// Nothing stopped the app's own window from navigating away from `nexus://app`.
// Desktop sign-in did exactly that — `window.location.href = <provider url>` in
// Login.tsx — and the redirect chain ended on the marketing site, in the window
// that used to be the app. There is no back button, no address bar and no menu,
// so that is a terminal state: the user's only move is to kill the process.
//
// A window that IS the application must never be used as a general-purpose
// browser. Anything that is not this app's own origin is cancelled here and
// handed to the real browser instead, which turns "the app is gone" into a new
// tab. That holds for the OAuth redirect, for a mis-built link in the renderer,
// and for whatever the next one turns out to be — the guard does not need to
// know why it was asked.
function isAppUrl(target) {
  try {
    const u = new URL(target);
    return u.protocol === `${SCHEME}:` && u.host === 'app';
  } catch {
    return false;
  }
}

// Only ever hand http(s) to the OS. `shell.openExternal` will happily launch
// other registered handlers, and a renderer bug that produced, say, a file:// or
// a custom-scheme URL should die quietly rather than start something.
function openExternally(target) {
  try {
    const u = new URL(target);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      log(`refused to open non-http external URL (${u.protocol})`);
      return false;
    }
    void shell.openExternal(target);
    return true;
  } catch {
    return false;
  }
}

function hardenNavigation(win) {
  const handoff = (event, target) => {
    if (isAppUrl(target)) return;
    event.preventDefault();
    log(`cancelled off-origin navigation: ${target}`);
    openExternally(target);
  };
  // `will-navigate` catches a link click or a location assignment; the
  // `will-redirect` pair catches a 30x issued part-way through a chain we did
  // allow. Neither fires for the SPA's own history.pushState routing.
  win.webContents.on('will-navigate', handoff);
  win.webContents.on('will-redirect', handoff);
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isAppUrl(url)) return { action: 'allow' };
    openExternally(url);
    return { action: 'deny' };
  });
}

// ── Desktop OAuth callback (v1.12.1, P0) ────────────────────────────────────
//
// Android has a deep link (`com.limecore.nexus://login-callback`) and the web
// build has its own origin. Desktop had neither, so `OAUTH_REDIRECT_URL`
// resolved to `nexus://app/` — a URL Supabase cannot be asked to redirect to —
// and the provider bounced to the project's Site URL instead.
//
// A loopback listener is what RFC 8252 prescribes for a native app, and on
// Windows it is markedly more reliable than registering a custom URI scheme:
// scheme registration is a per-machine installer concern that a zip build never
// performs at all, whereas 127.0.0.1 needs no registration and no elevation.
//
// The port list is FIXED rather than `listen(0)`. Supabase matches redirect
// URLs against an allow-list, so a random port could never be allowlisted —
// that is precisely the mistake the note at the top of this file records the
// v1.9 shell making with its random-port static server. The range is disjoint
// from StudyDesk's (51837-51841) so the two desktop apps do not compete for the
// same socket when both are open.
const AUTH_PORTS = [51842, 51843, 51844, 51845, 51846];
const AUTH_CALLBACK_PATH = '/callback';

let authRedirectUri = null;
// Only accept a callback that carries the `state` nonce of a sign-in this app
// started. The listener is reachable by anything running as this user, and an
// unsolicited code is at best noise and at worst an attempt to plant someone
// else's session. v1.16 (limecore#3) replaced the bare `authPending` boolean,
// which any local request could satisfy — and, by arriving first, consume.
// See authState.cjs.
const authState = createAuthState();

const CALLBACK_PAGE = (ok) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Nexus Command Center</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
       background:#0d1117;color:#e6edf3;font:16px/1.6 system-ui,sans-serif;text-align:center;padding:24px;}
  h1{font-size:20px;margin:0 0 8px;} p{margin:0;color:#8b949e;font-size:14px;}
</style></head><body><div>
  <h1>${ok ? 'Signed in' : 'Sign-in failed'}</h1>
  <p>${ok ? 'You can close this tab and go back to Nexus Command Center.' : 'Close this tab and try again from Nexus Command Center.'}</p>
</div></body></html>`;

// The provider's error text is deliberately NOT echoed into the page — it is
// attacker-influenceable and this response is HTML. It goes to the renderer,
// which renders it as text through React.
function handleAuthCallback(req, res) {
  let url = null;
  try {
    url = new URL(req.url, 'http://127.0.0.1');
  } catch {
    url = null;
  }
  if (!url || url.pathname !== AUTH_CALLBACK_PATH) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }

  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error_description') || url.searchParams.get('error');

  const verdict = authState.check(url.searchParams.get('state'));
  if (verdict === 'none') {
    log('discarded an unsolicited auth callback');
    res.writeHead(409, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('No sign-in is in progress');
    return;
  }
  if (verdict !== 'ok') {
    // 'mismatch' leaves the real sign-in armed; 'expired' has cleared it.
    // Either way nothing reaches the renderer. The nonce is never logged.
    log(`discarded an auth callback: state ${verdict}`);
    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(CALLBACK_PAGE(false));
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(CALLBACK_PAGE(Boolean(code) && !error));

  if (mainWindow && !mainWindow.isDestroyed()) {
    // The renderer holds the PKCE code verifier, so it — not this process —
    // has to redeem the code.
    mainWindow.webContents.send('auth:callback', { code: code || null, error: error || null });
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  } else {
    log('auth callback arrived with no main window to deliver it to');
  }
}

/** Bind the loopback listener, trying each candidate port in turn. Resolves to
 *  the redirect URI, or null if none of them was free — in which case desktop
 *  OAuth stays unavailable and email sign-in, which needs no redirect at all,
 *  still works. A missing listener must never stop the app from starting. */
function startAuthLoopback() {
  return new Promise((resolve) => {
    let i = 0;
    const server = http.createServer(handleAuthCallback);
    server.on('error', (err) => {
      if (err && err.code === 'EADDRINUSE' && i < AUTH_PORTS.length - 1) {
        i += 1;
        server.listen(AUTH_PORTS[i], '127.0.0.1');
        return;
      }
      log(`auth loopback could not listen: ${err && err.message}`);
      resolve(null);
    });
    server.on('listening', () => {
      authRedirectUri = `http://127.0.0.1:${AUTH_PORTS[i]}${AUTH_CALLBACK_PATH}`;
      log(`auth loopback listening on ${authRedirectUri}`);
      resolve(authRedirectUri);
    });
    server.listen(AUTH_PORTS[i], '127.0.0.1');
  });
}

function createWindow() {
  try {
    mainWindow = new BrowserWindow({
      width: 1440,
      height: 900,
      minWidth: 1024,
      minHeight: 700,
      icon: ICON_PATH,
      autoHideMenuBar: true,
      backgroundColor: '#0d1117', // matches the app's dark theme surface, avoids a white flash on load
      webPreferences: {
        // The bridge is a handful of IPC calls and adds no Node surface: a
        // sandboxed preload only gets contextBridge and ipcRenderer, which is
        // all `auth-preload.cjs` uses.
        preload: AUTH_PRELOAD,
        additionalArguments: authRedirectUri
          ? [`--nexus-auth-redirect=${authRedirectUri}`]
          : [],
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    hardenNavigation(mainWindow);

    mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
      log(`did-fail-load: code=${code} desc=${desc} url=${url}`);
    });
    mainWindow.webContents.on('did-finish-load', () => {
      log('did-finish-load — window rendered successfully');
    });
    mainWindow.webContents.on('render-process-gone', (_e, details) => {
      log(`render-process-gone: ${JSON.stringify(details)}`);
    });

    mainWindow.loadURL(`${APP_ORIGIN}/`);

    mainWindow.on('closed', () => {
      mainWindow = null;
    });
  } catch (err) {
    log(`createWindow FAILED: ${err && err.stack}`);
  }
}

// Renderer asks for the provider URL to be opened in the real browser. This is
// the only way a sign-in starts on desktop now. Arming `authState` here puts a
// fresh nonce on the URL's `redirect_to`, and only a callback carrying it back
// is accepted. The renderer is untouched: it still asks Supabase for the bare
// loopback URI, and the nonce is added on the way out. `arm` refuses anything
// that is not https or does not redirect to this launch's own listener.
ipcMain.handle('auth:begin', (_event, url) => {
  const target = authState.arm(url, authRedirectUri);
  if (!target) {
    log('refused auth:begin: not an https URL redirecting to this listener');
    return false;
  }
  const opened = openExternally(target);
  if (!opened) authState.disarm();
  return opened;
});

// v1.15 (Item 12) — find, download and install updates (electron-updater),
// with a notice-only fallback. See updater.cjs.
setupUpdates({
  repo: 'Limecore-Studio/nexus-command-center',
  installerPrefix: 'NexusCommandCenter-Desktop-Setup-',
  log,
  getWindow: () => mainWindow,
  openExternally,
});

app.whenReady().then(async () => {
  log('app.whenReady resolved');
  registerProtocolHandler();
  log(`serving ${DIST_DIR} at ${APP_ORIGIN}/ (stable origin)`);
  // Before createWindow: the redirect URI is passed to the renderer as a
  // preload argument, which is fixed at window-construction time.
  await startAuthLoopback();
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
