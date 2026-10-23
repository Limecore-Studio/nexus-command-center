// v1.18.1 — account switch: the adoption choice comes first. Where the
// signed-in account stands with the "Existing data found" question. App.tsx
// renders the app (and starts the hydration, realtime and sync) only once
// this reads "clear" for the account on screen; useSyncStore refuses to run
// before that. Decided by lib/adoptionChoice.ts. No imports beyond zustand, so
// the sync store can read it without pulling in the decision's dependencies.
import { create } from 'zustand';

/** checking: not known yet. ask: the prompt is the only thing on screen.
 *  clear: the app may show and sync this device's data. */
export type AdoptionStatus = 'checking' | 'ask' | 'clear';

interface AdoptionGate {
  /** The account `status` is about; any other account counts as "checking". */
  userId: string | null;
  status: AdoptionStatus;
}

/** v1.19 (limecore#66) — the gate's (and the device's "last account") id for
 *  a guest. Not a uuid, so it never matches a real account: the next sign-in
 *  over a guest's data is an account switch. */
export const GUEST_ID = 'guest';

export const useAdoptionGate = create<AdoptionGate>(() => ({ userId: null, status: 'checking' }));

export function setAdoptionStatus(userId: string, status: AdoptionStatus): void {
  useAdoptionGate.setState({ userId, status });
}

/** May the app show and sync local data for `userId`? */
export function adoptionClearFor(userId: string | null | undefined): boolean {
  const s = useAdoptionGate.getState();
  return !!userId && s.userId === userId && s.status === 'clear';
}

/** v1.18.1 — may the device's data be exported (Settings, the crash screen)?
 *  Signed in: only once that account has answered. No account: only when no
 *  account has been on screen this launch (a guest); otherwise one is waiting
 *  to answer, or its state is unknown. */
export function exportAllowed(userId: string | null | undefined): boolean {
  if (userId) return adoptionClearFor(userId);
  // v1.19 (limecore#66): a guest, once the guest gate is clear.
  const s = useAdoptionGate.getState();
  return s.userId === null || (s.userId === GUEST_ID && s.status === 'clear');
}

/** v1.19 (limecore#66) — may a guest see and be reminded of local data? */
export function guestClear(): boolean {
  return adoptionClearFor(GUEST_ID);
}
