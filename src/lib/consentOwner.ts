// v1.21.1 (limecore#87) — whose opt-in answers apply right now: the signed-in
// account, or the guest. App.tsx keeps it current. Split from usageConsent.ts
// so only these few lines load at startup (scripts/check-bundle-size.mjs).
import { GUEST_ID } from './adoptionGate';

export const consentListeners = new Set<() => void>();
export const notifyConsent = () => consentListeners.forEach((l) => l());

let owner: string = GUEST_ID;
export function setConsentOwner(userId: string | null | undefined): void {
  const next = userId || GUEST_ID;
  if (next === owner) return;
  owner = next;
  notifyConsent();
}
export function currentOwner(): string {
  return owner;
}
