// v1.18.1 — account switch: the adoption choice comes first. When the device
// holds data kept by another account (or a guest) and a different account
// signs in, that account answers "Existing data found" before the app shows
// any of it: Keep (adopt into this account) or Discard, or sign out again.
// There is no "Decide later" any more. It was a per-launch, in-memory skip
// (never stored), so no stored state needs migrating: the next launch simply
// asks. The device's and the cloud's "already answered" flags are per account,
// so on an account switch they are not consulted (see evaluateAdoption).
//
// This module decides (evaluateAdoption); lib/adoptionAnswer.ts carries out
// the answer (in the prompt's own chunk); AdoptionPrompt is the UI and
// lib/adoptionGate.ts holds the result that App.tsx and the sync wait on.
import { db } from '../db/database';
import { hasGuestEdits } from '../db/syncQueue';
import { hasLocalData } from './cloudSync';
import { getDismissedFromCloud, readDecided, recordDecision, writeDecided } from './adoptionFlag';
import { GUEST_ID } from './adoptionGate';

// v1.2.1 — the last account that answered (or had nothing to answer) on this
// device. Its own per-account flags cannot tell B that A's data is here, so a
// different id here plus data on the device means an account switch.
export const LAST_USER_KEY = 'nexus.lastSignedInUserId';
export function readLastUserId(): string | null {
  try {
    return localStorage.getItem(LAST_USER_KEY);
  } catch {
    return null;
  }
}
function writeLastUserId(userId: string): void {
  try {
    localStorage.setItem(LAST_USER_KEY, userId);
  } catch {
    /* quota / private-mode — best-effort */
  }
}

// Accounts that answered during this launch. A check still waiting on the
// cloud when the answer lands must not bring the question back.
const answered = new Set<string>();

/** v1.18.1 — any rows at all in the tables the app shows. hasLocalData counts
 *  only never-synced rows (it decides what Keep would upload); kept data that
 *  had already synced to the previous account is still that account's data,
 *  and on an account switch it is shown just the same. */
export async function hasAnyLocalData(): Promise<boolean> {
  // Every table but the price cache and the sync queue (clearAllLocalData's
  // list, which a test holds to db.tables), so a new table is covered too.
  const tables = db.tables.filter((t) => t.name !== 'apiCache' && t.name !== 'syncQueue');
  const counts = await Promise.all(tables.map((t) => t.count()));
  return counts.some((c) => c > 0);
}

/**
 * Must `userId` answer the prompt before the app opens? Local checks first, so
 * an account switch is caught with no network at all (offline, an unverified
 * session), and an empty device opens at once. `onOwnData` is called before
 * the one network read when the data belongs to this same account (it may
 * open the app meanwhile); the answer can still turn out "ask" for that
 * account's own pre-sign-in data, as before.
 *
 * v1.18.1 — every "clear" also records this account as the device's last
 * one. Otherwise its own rows, pulled after the app opened, would later read
 * as another account's (a re-check when the device comes online, or the next
 * launch) and bring the question up over them.
 */
export async function evaluateAdoption(userId: string, onOwnData?: () => void): Promise<'ask' | 'clear'> {
  if (answered.has(userId)) return 'clear';
  const previousUserId = readLastUserId();
  const unanswered = () => !answered.has(userId);
  const anyData = await hasAnyLocalData();
  if (previousUserId !== null && previousUserId !== userId && anyData) {
    return unanswered() && readLastUserId() !== userId ? 'ask' : 'clear';
  }
  // v1.18.1 (NCC#140): edits made as a guest since then push only after
  // "Keep" (db/syncQueue.ts), so they are this user's to answer for even
  // when the device's earlier answer would skip the prompt.
  if (await hasGuestEdits()) return unanswered() ? 'ask' : 'clear';
  const open = (): 'clear' => {
    writeLastUserId(userId);
    return 'clear';
  };
  // v1.18.1 — nothing on the device: nothing to adopt and no one else's data,
  // so no network read either (it could take FLAG_READ_TIMEOUT_MS offline).
  if (!anyData) {
    if (readDecided(userId) !== 'synced') recordDecision(userId);
    return open();
  }
  // v1.19 — NCC#139: a decision already made on this device needs no
  // network. A cloud write that hasn't landed yet is retried here.
  const decided = readDecided(userId);
  if (decided) {
    if (decided === 'pending') recordDecision(userId);
    return open();
  }
  const hasData = await hasLocalData();
  if (previousUserId === userId) onOwnData?.();
  const dismissed = await getDismissedFromCloud(userId);
  // Could not ask (offline, timed out): say nothing now; the `online` event
  // or the next launch asks again. The data here is this account's or a
  // guest's (another account's was caught above).
  if (dismissed === null) return open();
  if (dismissed) {
    writeDecided(userId, 'synced');
    return open();
  }
  if (!hasData) {
    // Nothing to adopt: remember that, so the next launch needs no network.
    recordDecision(userId);
    return open();
  }
  return unanswered() && !readDecided(userId) ? 'ask' : 'clear';
}

export { GUEST_ID };

/** v1.19 (limecore#66) — must a guest answer "Existing data found" first?
 *  Only when an account's kept data is on the device. All local, no network. */
export async function evaluateGuestAdoption(): Promise<'ask' | 'clear'> {
  if (answered.has(GUEST_ID)) return 'clear';
  const previousUserId = readLastUserId();
  if (previousUserId !== null && previousUserId !== GUEST_ID && (await hasAnyLocalData())) {
    return answered.has(GUEST_ID) ? 'clear' : 'ask';
  }
  // An earlier device with no last account keeps its guest data unprompted,
  // as before; marked now so a later sign-in over it asks.
  if (previousUserId === null && (await hasAnyLocalData())) writeLastUserId(GUEST_ID);
  return 'clear';
}

/** v1.19 (limecore#66) — a guest's answer: for this launch and on the device.
 *  No cloud flag (there is no account). */
export function rememberGuest(): void {
  answered.add(GUEST_ID);
  writeLastUserId(GUEST_ID);
}

/** Records an answer (Keep or Discard) for `userId`: for this launch, on the
 *  device, and in the cloud when it can. See lib/adoptionAnswer.ts. */
export function remember(userId: string): void {
  answered.add(userId);
  // Remembered on the device first; the cloud copy follows when it can.
  recordDecision(userId);
  writeLastUserId(userId);
}
