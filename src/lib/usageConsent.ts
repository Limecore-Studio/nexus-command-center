// v1.21.1 (limecore#87) — the app-open record and the F-Droid update check
// are opt-in, off until the owner says yes.
//
// - Per owner, not per device: the answer is kept under the account id, or
//   the guest id, so a second account on the same phone is asked for itself
//   (design A later moves this into the owner's own storage).
// - Not asked = off. Existing installs count as not asked: nothing carries the
//   old default ("on unless switched off") forward, which is the point.
// - Everything here loads on demand (the callers are lazy); only the owner
//   tracking in consentOwner.ts is on the startup path.
import { useSyncExternalStore } from 'react';
import { Capacitor } from '@capacitor/core';
import { GUEST_ID } from './adoptionGate';
import { consentListeners as listeners, currentOwner, notifyConsent as notify } from './consentOwner';

export { currentOwner, setConsentOwner } from './consentOwner';

export type ConsentTopic = 'appOpens' | 'updateCheck';

const keyFor = (topic: ConsentTopic, owner: string) => `nexus.consent.${topic}.${owner}`;


/** true / false once answered, null while not asked. */
export function readConsent(topic: ConsentTopic, owner = currentOwner()): boolean | null {
  try {
    const v = localStorage.getItem(keyFor(topic, owner));
    return v === 'yes' ? true : v === 'no' ? false : null;
  } catch {
    return null;
  }
}

export const consented = (topic: ConsentTopic, owner?: string) => readConsent(topic, owner) === true;

export function setConsent(topic: ConsentTopic, on: boolean, owner = currentOwner()): void {
  try {
    localStorage.setItem(keyFor(topic, owner), on ? 'yes' : 'no');
  } catch {
    /* storage unavailable: stays off, and is asked again */
  }
  notify();
}

/** The questions this owner has not answered yet, in the order asked. The
 *  app-open record needs an account; the update check is Android only. */
export function pendingConsent(owner = currentOwner(), platform = Capacitor.getPlatform()): ConsentTopic[] {
  const out: ConsentTopic[] = [];
  if (platform === 'android' && readConsent('updateCheck', owner) === null) out.push('updateCheck');
  if (owner !== GUEST_ID && readConsent('appOpens', owner) === null) out.push('appOpens');
  return out;
}

export function useConsent(topic: ConsentTopic): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => readConsent(topic) === true,
    () => false,
  );
}
