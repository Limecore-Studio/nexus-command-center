// v1.22 (limecore#127) — route deep links: com.limecore.nexus://open/<route>.
//
// The Android launcher shortcuts (res/xml/shortcuts.xml) open these, and other
// apps of the suite may too. Only the routes below are accepted; anything else
// is ignored, so a link can open a screen but never carries data or acts on
// its own.
//
// A link is held as pending until the app shell is up: App.tsx sets it (from
// `appUrlOpen`, or the launch URL on a cold start) and AppShell acts on it when
// it mounts or when told. Signed out, the shell is not mounted, so the link
// waits through sign-in (or Continue as guest) and opens its target after.

export const DEEP_LINK_SCHEME = 'com.limecore.nexus';

export type DeepLinkTarget = { kind: 'route'; path: string } | { kind: 'quickLog' };

const ROUTES: Record<string, DeepLinkTarget> = {
  expense: { kind: 'route', path: '/finance/add' },
  quicklog: { kind: 'quickLog' },
  tasks: { kind: 'route', path: '/tasks' },
};

/** The target of `com.limecore.nexus://open/<route>`, or null for any other
 *  URL (the sign-in callback included). */
export function parseDeepLink(url: string): DeepLinkTarget | null {
  const m = /^com\.limecore\.nexus:\/\/open\/([a-z]+)\/?(?:[?#].*)?$/i.exec(url.trim());
  if (!m) return null;
  return ROUTES[m[1].toLowerCase()] ?? null;
}

let pending: DeepLinkTarget | null = null;
export const DEEP_LINK_EVENT = 'nexus:deeplink';

/** Holds a link for the shell and tells it, if it is listening. */
export function queueDeepLink(url: string): boolean {
  const target = parseDeepLink(url);
  if (!target) return false;
  pending = target;
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(DEEP_LINK_EVENT));
  return true;
}

/** The waiting link, once: the shell acts on it. */
export function takeDeepLink(): DeepLinkTarget | null {
  const t = pending;
  pending = null;
  return t;
}
