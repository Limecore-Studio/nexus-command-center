// v1.20 (limecore#71) — the one-time question that offers error reports.
//
// Reports work end to end, but client_errors had no rows, ever: the only way
// in was a switch deep in Settings. This asks once per device, on the second
// signed-in launch so it never stacks with sign-in or onboarding, and not
// while the "privacy policy updated" strip is up. The answer is kept next to
// the switch, which is device-local too, and Settings stays the way back.
//
// Never for guests: reports are accounts-only (errorReports.ts sendReport),
// and AppShell only mounts the card with a session.

import { errorReportsEnabled, setErrorReportsEnabled } from './errorReports';
import { policyNoticeDue } from './policyNotice';

const ASKED = 'nexus.errorReportsAsked'; // 'yes' | 'no' once answered
const LAUNCHES = 'nexus.errorReportsLaunches'; // signed-in launches counted so far
let counted = false;

/** Count this launch as a signed-in one, once per page load. */
export function noteSignedInLaunch(): void {
  if (counted) return;
  counted = true;
  try {
    const n = Number(localStorage.getItem(LAUNCHES)) || 0;
    localStorage.setItem(LAUNCHES, String(n + 1));
  } catch {
    /* storage unavailable: never ask, which is the safe side */
  }
}

/** Whether to show the card now. Someone who already turned reports on in
 *  Settings has answered, so that counts as asked. */
export function shouldAskForReports(): boolean {
  try {
    if (localStorage.getItem(ASKED)) return false;
    if (errorReportsEnabled()) {
      localStorage.setItem(ASKED, 'yes');
      return false;
    }
    if (policyNoticeDue()) return false;
    return (Number(localStorage.getItem(LAUNCHES)) || 0) >= 2;
  } catch {
    return false;
  }
}

/** Record the answer; Yes turns the existing switch on. */
export function answerReportPrompt(yes: boolean): void {
  try {
    localStorage.setItem(ASKED, yes ? 'yes' : 'no');
  } catch {
    /* asked again next launch */
  }
  if (yes) setErrorReportsEnabled(true);
}

export function resetReportPromptForTests(): void {
  counted = false;
}
