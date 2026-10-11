import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { App as CapacitorApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { useConfirm } from './ConfirmDialog';
import { adoptLocalData, hasLocalData } from '../lib/cloudSync';
import { clearAllLocalData } from '../db/database';
import { useSessionStore } from '../store/useSessionStore';
import { useSyncStore } from '../store/useSyncStore';
import {
  getDismissedFromCloud,
  readDecided,
  recordDecision,
  writeDecided,
} from '../lib/adoptionFlag';

// v1.1.1 — BUG-2 fix: dismiss flag now lives in Supabase, not Capacitor
// Preferences. Android wipes SharedPreferences on app uninstall, so the
// pre-1.1.1 flag never survived reinstalls — the user was re-prompted on
// every fresh install despite the "won't ask again on this account"
// language. Supabase is the only storage that survives reinstalls.
//
// Storage: public.user_preferences keyed on auth.uid(), column
// `ncc_local_data_prompt_dismissed BOOLEAN`. Migration:
// `create_user_preferences_for_local_data_prompt` (2026-05-27).
//
// Migration path for v1.1.0 users: anyone who already dismissed in 1.1.0
// will see the prompt ONE more time on upgrade (the old local flag is
// no longer consulted). After they dismiss in 1.1.1, the Supabase row
// lands and they're never asked again — across any number of reinstalls.
//
// v1.2.1 — AUDIT-FSG-2b fix: shared-device user-change re-fire. The cloud
// flag is per-user, so a returning B who previously dismissed under their
// own auth.uid() never sees the prompt — and User A's Dexie data sits
// invisibly on the device. The FSG-2 fix closes the cloud REPLAY path
// (syncQueue drains on sign-out so A's writes can't push under B), but
// the local data is still rendered through B's views once they sign in.
// Tracking `nexus.lastSignedInUserId` in localStorage gives us a second
// gate: when the current user_id differs from the previous one AND there
// IS local data present, force-show the prompt regardless of the cloud
// dismiss flag. Once B picks Keep&Sync or Discard, the marker advances
// so the same B-session doesn't re-prompt on subsequent mounts.
const LAST_USER_KEY = 'nexus.lastSignedInUserId';
function readLastUserId(): string | null {
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

// v1.19 — NCC#139: see src/lib/adoptionFlag.ts for why this prompt no longer
// appears offline and remembers decisions on the device.
// "Decide later" lasts for this launch. Module scope rather than component
// state, so a remount (sign-in churn, a route change) doesn't re-ask.
const deferredThisLaunch = new Set<string>();

export default function AdoptionPrompt() {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const user = useSessionStore((s) => s.user);
  const syncNow = useSyncStore((s) => s.syncNow);
  const refreshPending = useSyncStore((s) => s.refreshPending);
  const [show, setShow] = useState(false);
  // True while Discard's confirmation is open, so Escape / back close that
  // dialog's question, not the prompt underneath it.
  const confirmingRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  // Bumped by the browser's `online` event so an "unknown" answer is asked
  // again once the device has a connection.
  const [recheck, setRecheck] = useState(0);

  useEffect(() => {
    const onOnline = () => setRecheck((n) => n + 1);
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, []);

  // Decide whether to show on mount + when user changes.
  useEffect(() => {
    let cancelled = false;
    // v1.19 — NCC#141 review: a run started by the `online` re-check can
    // still be waiting on the cloud when the user answers the prompt. Its
    // answer was computed before that, so check again right before showing.
    const showUnlessAnswered = (userId: string, userChange: boolean) => {
      if (cancelled || deferredThisLaunch.has(userId)) return;
      if (userChange ? readLastUserId() === userId : readDecided(userId)) return;
      setShow(true);
    };
    (async () => {
      if (!user) {
        if (!cancelled) setShow(false);
        return;
      }
      if (deferredThisLaunch.has(user.id)) {
        if (!cancelled) setShow(false);
        return;
      }
      // v1.2.1 — AUDIT-FSG-2b: force-show on user transition (shared device).
      // If a different signed-in user was previously seen on this install
      // AND there is local data present, prompt regardless of the cloud
      // dismiss flag. This is the only path that catches the "User B signs
      // in after User A signed out on the same device" case, since B's
      // cloud-stored dismiss flag is keyed to B's auth.uid() and doesn't
      // know A ever existed here.
      const previousUserId = readLastUserId();
      const hasData = await hasLocalData();
      const isUserChange =
        previousUserId !== null && previousUserId !== user.id && hasData;
      if (isUserChange) {
        showUnlessAnswered(user.id, true);
        return;
      }
      // v1.19 — NCC#139: a decision already made on this device needs no
      // network. A cloud write that hasn't landed yet is retried here.
      const decided = readDecided(user.id);
      if (decided) {
        if (decided === 'pending') recordDecision(user.id);
        writeLastUserId(user.id);
        if (!cancelled) setShow(false);
        return;
      }
      const dismissed = await getDismissedFromCloud(user.id);
      if (dismissed === null) {
        // Could not ask (offline, timed out). Say nothing now; the `online`
        // event or the next launch asks again.
        if (!cancelled) setShow(false);
        return;
      }
      if (dismissed) {
        // Already dismissed by THIS user previously — advance the marker
        // so we don't re-evaluate the user-change branch next mount.
        writeDecided(user.id, 'synced');
        writeLastUserId(user.id);
        if (!cancelled) setShow(false);
        return;
      }
      if (!hasData) {
        // No local data → silently mark dismissed in the cloud so we
        // don't re-check on every launch. If the write fails, the local
        // "pending" marker retries it on a later launch. Idempotent.
        recordDecision(user.id);
        writeLastUserId(user.id);
        if (!cancelled) setShow(false);
        return;
      }
      showUnlessAnswered(user.id, false);
    })();
    return () => {
      cancelled = true;
    };
  }, [user, recheck]);

  const onLater = () => {
    if (!user || busy || confirmingRef.current) return;
    deferredThisLaunch.add(user.id);
    setShow(false);
  };

  // Escape on desktop/web and the Android back button both mean "later" —
  // the prompt used to have no way out at all. A back-button listener also
  // stops Capacitor's default back action (leave the app) while it is open.
  useEffect(() => {
    if (!show) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onLater();
    };
    window.addEventListener('keydown', onKey);
    const back = Capacitor.isNativePlatform()
      ? CapacitorApp.addListener('backButton', () => onLater())
      : null;
    return () => {
      window.removeEventListener('keydown', onKey);
      void back?.then((h) => h.remove());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onLater is a new function every render; its inputs (user, busy) are the deps, so it is re-bound exactly when they change rather than churning the native listener each render
  }, [show, busy, user]);

  if (!show || !user) return null;

  const onKeep = async () => {
    setBusy(true);
    setFailed(false);
    try {
      // Local only: every row goes into the sync queue. Nothing here waits
      // on the network, so offline it finishes as fast as online.
      await adoptLocalData(user.id);
      // The sync's `online` and 30 s triggers only fire when they see queued
      // rows, and offline nothing refreshes that count — so without this,
      // rows queued offline waited for the next launch to go up.
      void refreshPending();
      // Remember the decision BEFORE hiding the UI so a misfired re-mount
      // doesn't re-prompt; the cloud copy follows when it can.
      recordDecision(user.id);
      // v1.2.1 — AUDIT-FSG-2b: advance the user-change marker so the next
      // mount in this session doesn't trip the user-transition branch.
      writeLastUserId(user.id);
      setShow(false);
      // v1.19 — NCC#139: was awaited inside the modal, which offline meant
      // "Working…" for good. The queue pushes whenever the sync can run.
      void syncNow();
    } catch (e) {
      console.warn('[adoption] keep failed:', (e as Error).message);
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  const onDiscard = async () => {
    confirmingRef.current = true;
    const ok = await confirm({ message: t('common.wipeTestData') }).finally(() => {
      confirmingRef.current = false;
    });
    if (!ok) return;
    setBusy(true);
    setFailed(false);
    try {
      await clearAllLocalData();
      // Same pattern as onKeep — remember the decision before the reload so
      // the post-reload mount sees it, whether or not the cloud write lands.
      recordDecision(user.id);
      // v1.2.1 — AUDIT-FSG-2b: advance the user-change marker. Both
      // adoption outcomes (Keep + Discard) count as "user has acted",
      // so subsequent mounts under the same user_id should follow the
      // cloud-dismiss branch only.
      writeLastUserId(user.id);
      setShow(false);
      // Force a reload so all stores re-init with the empty DB.
      window.location.reload();
    } catch (e) {
      console.warn('[adoption] discard failed:', (e as Error).message);
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-bg/90 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="adoption-title"
    >
      <div className="card-elevated max-w-sm w-full">
        <h2 id="adoption-title" className="font-heading font-bold text-lg mb-2">{t('adoption.title')}</h2>
        <p className="text-sm text-text-muted mb-4">{t('adoption.body')}</p>
        <div className="space-y-2">
          <button
            onClick={onKeep}
            disabled={busy}
            className="btn w-full"
          >
            {busy ? t('adoption.working') : t('adoption.keep')}
          </button>
          <button
            onClick={onDiscard}
            disabled={busy}
            className="btn-ghost w-full text-danger border-danger/40"
          >
            {t('adoption.discard')}
          </button>
          <button
            onClick={onLater}
            disabled={busy}
            className="btn-ghost w-full"
          >
            {t('adoption.later')}
          </button>
        </div>
        {failed && (
          <p role="alert" className="text-sm text-danger mt-3 text-center">
            {t('adoption.failed')}
          </p>
        )}
        {/* v1.1 — UI/UX review #6: 10px → 11px on a legal-flavored disclosure. */}
        <p className="text-[0.6875rem] text-text-muted mt-3 text-center">
          {t('adoption.footer')}
        </p>
      </div>
    </div>
  );
}
