// v1.22 (StudyDesk#260, NCC half) — users on the phone app don't know NCC
// also runs in a browser and on Windows, signed in to the same account. The
// Settings section links both; a one-time Dashboard note says so once, after
// the first week of use.
import { Capacitor } from '@capacitor/core';
import { IS_DESKTOP } from './isDesktop';

export const WEB_APP_URL = 'https://nexus.limecore.dev';
export const DESKTOP_DOWNLOAD_URL = 'https://github.com/Limecore-Studio/nexus-command-center/releases/latest';

/** Which of the two to offer here: not the edition already in use. */
export function computerAppsOffered(): { web: boolean; desktop: boolean } {
  const native = Capacitor.isNativePlatform();
  return { web: native || IS_DESKTOP, desktop: !IS_DESKTOP };
}

const WEEK_MS = 7 * 86_400_000;
const noteKey = (userId: string) => `nexus.computerAppsNote.${userId}`;

/** The Dashboard note: on the phone app only, for an account older than a
 *  week that has synced, and once per account on this device. */
export function computerNoteDue(
  user: { id: string; created_at?: string } | null | undefined,
  lastSyncedAt: string | null,
  now: number = Date.now(),
): boolean {
  if (!user || !lastSyncedAt || !Capacitor.isNativePlatform()) return false;
  const created = user.created_at ? Date.parse(user.created_at) : NaN;
  if (!(now - created > WEEK_MS)) return false;
  try {
    return !localStorage.getItem(noteKey(user.id));
  } catch {
    return false;
  }
}

export function dismissComputerNote(userId: string): void {
  try {
    localStorage.setItem(noteKey(userId), new Date().toISOString());
  } catch {
    /* private mode / quota: it shows again next launch */
  }
}
