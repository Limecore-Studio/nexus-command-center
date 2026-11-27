// v1.22 (limecore#131) — "Open in StudyDesk / LimeLog" from the cards that show
// their data. NCC only reads that data; the link carries a route and at most an
// id, never data.
//
// Route URLs are the ones the two apps accept (StudyDesk#297; LimeLog's
// limecore#127 PR). On Android the app opens through the LimecoreAppLink
// plugin, pinned to the sibling's package; when it is not installed, its
// F-Droid page opens instead. On the web and the desktop edition there is no
// app to open: StudyDesk's web app opens, and for LimeLog its F-Droid page.
// Loaded on the first tap, outside the startup bundle.
import { Capacitor, registerPlugin } from '@capacitor/core';

interface AppLinkApi {
  open(options: { url: string; packageName: string }): Promise<{ opened: boolean }>;
}
const LimecoreAppLink = registerPlugin<AppLinkApi>('LimecoreAppLink');

export type SuiteApp = 'studydesk' | 'limelog';

const APPS: Record<SuiteApp, { scheme: string; packageName: string; store: string; web?: string }> = {
  studydesk: {
    scheme: 'com.studydesk.app',
    packageName: 'com.StudyDesk.app',
    store: 'https://f-droid.org/packages/com.StudyDesk.app/',
    web: 'https://studydesk.limecore.dev/',
  },
  limelog: {
    scheme: 'com.limecore.workouttracker',
    packageName: 'com.limecore.workouttracker',
    store: 'https://f-droid.org/packages/com.limecore.workouttracker/',
  },
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROUTES: Record<SuiteApp, (route: string) => boolean> = {
  studydesk: (r) => r === 'today' || r === 'plan' || r === 'timer' || (r.startsWith('course/') && UUID.test(r.slice(7))),
  limelog: (r) => r === 'today' || r === 'progress' || (r.startsWith('workout/') && UUID.test(r.slice(8))),
};

/** `<scheme>://open/<route>`, or null for a route the app does not accept. */
export function suiteAppUrl(app: SuiteApp, route: string): string | null {
  return ROUTES[app](route) ? `${APPS[app].scheme}://open/${route}` : null;
}

function openExternal(url: string): void {
  // Off-origin links leave the app: the system browser on the desktop edition,
  // a new tab on the web.
  window.open(url, '_blank', 'noopener,noreferrer');
}

export async function openInSuiteApp(app: SuiteApp, route: string): Promise<void> {
  const url = suiteAppUrl(app, route);
  if (!url) return;
  const target = APPS[app];
  if (!Capacitor.isNativePlatform()) {
    openExternal(target.web ?? target.store);
    return;
  }
  const opened = await LimecoreAppLink.open({ url, packageName: target.packageName })
    .then((r) => r.opened)
    .catch(() => false);
  if (!opened) {
    const { Browser } = await import('@capacitor/browser');
    await Browser.open({ url: target.store });
  }
}
