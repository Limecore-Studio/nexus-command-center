// v1.19 — NCC#139: the "Existing data found" prompt's dismissed flag, split
// out of AdoptionPrompt.tsx so the offline rules can be unit-tested.
import { supabase } from './supabase';

// v1.19 — NCC#139. Offline, this prompt used to lock the app: the flag read
// below failed, failure counted as "not dismissed", so it appeared on every
// offline launch; Keep then awaited a full sync that could not finish, behind
// a full-screen overlay with no way out. Three changes:
//   - the flag read is three-state, and "could not ask" no longer shows the
//     prompt (it re-checks when the device comes back online);
//   - the decision is remembered on this device the moment it is made, so it
//     never depends on the cloud write landing ("pending" until it does, and
//     the write is retried on later launches);
//   - Keep only queues the rows (local work) and lets the sync run in the
//     background.
// (v1.18.1 — the prompt's "Decide later" is gone; see lib/adoptionChoice.ts.)
export const DECIDED_PREFIX = 'nexus.adoptionDecided.';
export type Decided = 'pending' | 'synced';
export function readDecided(userId: string): Decided | null {
  try {
    const v = localStorage.getItem(DECIDED_PREFIX + userId);
    return v === 'pending' || v === 'synced' ? v : null;
  } catch {
    return null;
  }
}
export function writeDecided(userId: string, value: Decided): void {
  try {
    localStorage.setItem(DECIDED_PREFIX + userId, value);
  } catch {
    /* quota / private-mode — best-effort */
  }
}
export function recordDecision(userId: string): void {
  writeDecided(userId, 'pending');
  void setDismissedInCloud(userId).then((ok) => {
    if (ok) writeDecided(userId, 'synced');
  });
}

// The flag read is one small row; online it answers in well under a second.
// Past this the answer counts as unknown rather than holding the decision.
export const FLAG_READ_TIMEOUT_MS = 8000;

/** true / false when the cloud answered, null when it could not be asked. */
export async function getDismissedFromCloud(userId: string): Promise<boolean | null> {
  try {
    const read = supabase
      .from('user_preferences')
      .select('ncc_local_data_prompt_dismissed')
      .eq('user_id', userId)
      .maybeSingle();
    const res = await Promise.race([
      read,
      new Promise<null>((r) => setTimeout(() => r(null), FLAG_READ_TIMEOUT_MS)),
    ]);
    if (!res) {
      console.warn('[adoption] read user_preferences timed out');
      return null;
    }
    if (res.error) {
      // Was "show the prompt anyway". Offline that put it up on every launch
      // for nearly every synced user (hasLocalData() counts pulled rows too),
      // and nothing is lost by waiting: the local rows stay where they are
      // until the question can be asked.
      console.warn('[adoption] read user_preferences failed:', res.error.message);
      return null;
    }
    return !!res.data?.ncc_local_data_prompt_dismissed;
  } catch (e) {
    console.warn('[adoption] read user_preferences threw:', (e as Error).message);
    return null;
  }
}

/** Resolves true when the flag is stored in the cloud. */
export async function setDismissedInCloud(userId: string): Promise<boolean> {
  try {
    const { error } = await supabase
      .from('user_preferences')
      .upsert({
        user_id: userId,
        ncc_local_data_prompt_dismissed: true,
        updated_at: new Date().toISOString(),
      });
    if (error) {
      // Failure here just means the next reinstall will re-prompt — annoying
      // but not data-loss. Log so we notice if this becomes systemic.
      console.warn('[adoption] write user_preferences failed:', error.message);
      return false;
    }
    return true;
  } catch (e) {
    console.warn('[adoption] write user_preferences threw:', (e as Error).message);
    return false;
  }
}
