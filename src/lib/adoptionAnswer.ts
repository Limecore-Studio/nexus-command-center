// v1.18.1 — account switch: the adoption choice comes first. The two answers
// to "Existing data found". Imported by AdoptionPrompt only, so they load with
// its chunk; when to ask is lib/adoptionChoice.ts.
import { clearAllLocalData } from '../db/database';
import { adoptLocalData } from './cloudSync';
import { remember } from './adoptionChoice';
import { setAdoptionStatus } from './adoptionGate';

/** Keep: every local row is queued for this account (local work only, so it
 *  finishes offline too; the queue uploads when the sync can run). Opens the
 *  app for this account. */
export async function keepLocalData(userId: string): Promise<void> {
  await adoptLocalData(userId);
  remember(userId);
  setAdoptionStatus(userId, 'clear');
}

/** Discard: wipes the device (clearAllLocalData also cancels every reminder).
 *  The caller reloads; the gate stays shut until then. */
export async function discardLocalData(userId: string): Promise<void> {
  await clearAllLocalData();
  remember(userId);
}
