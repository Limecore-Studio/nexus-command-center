// v1.18.1 — account switch: the adoption choice comes first. The two answers
// to "Existing data found". Imported by AdoptionPrompt only, so they load with
// its chunk; when to ask is lib/adoptionChoice.ts.
import { clearAllLocalData } from '../db/database';
import { adoptLocalData, dropSyncedRows } from './cloudSync';
import { GUEST_ID, readLastUserId, remember, rememberGuest } from './adoptionChoice';
import { setAdoptionStatus } from './adoptionGate';

/** Keep: every unsynced local row is queued for this account (local work
 *  only, so it finishes offline too; the queue uploads when the sync can run).
 *  Opens the app for this account. v1.19 (NCC#189): on an account switch the
 *  previous account's synced rows leave the device; they are in its cloud. */
export async function keepLocalData(userId: string): Promise<void> {
  const last = readLastUserId();
  await adoptLocalData(userId);
  if (last !== null && last !== userId) await dropSyncedRows();
  remember(userId);
  setAdoptionStatus(userId, 'clear');
}

/** v1.19 (limecore#66) — a guest's Keep: the unsynced rows stay as guest
 *  data; the signed-out account's synced rows leave the device (they are in
 *  its cloud and come back when it signs in). */
export async function keepAsGuest(): Promise<void> {
  await dropSyncedRows();
  rememberGuest();
  setAdoptionStatus(GUEST_ID, 'clear');
}

/** v1.19 (limecore#66) — a guest's Discard. The caller reloads. */
export async function discardAsGuest(): Promise<void> {
  await clearAllLocalData();
  rememberGuest();
}

/** Discard: wipes the device (clearAllLocalData also cancels every reminder).
 *  The caller reloads; the gate stays shut until then. */
export async function discardLocalData(userId: string): Promise<void> {
  await clearAllLocalData();
  remember(userId);
}
