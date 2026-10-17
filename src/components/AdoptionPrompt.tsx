import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { App as CapacitorApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { useConfirm } from './ConfirmDialog';
import { readLastUserId } from '../lib/adoptionChoice';
import { discardLocalData, keepLocalData } from '../lib/adoptionAnswer';
import { useSessionStore } from '../store/useSessionStore';
import { useSyncStore } from '../store/useSyncStore';

// v1.1.1 — BUG-2: the "already answered" flag lives in Supabase
// (user_preferences.ncc_local_data_prompt_dismissed), so it survives
// reinstalls; v1.19 — NCC#139 also remembers it on the device
// (lib/adoptionFlag.ts). When to ask is decided in lib/adoptionChoice.ts.
//
// v1.18.1 — account switch: the adoption choice comes first. App.tsx renders
// this on its own, on the plain background, in place of the app: nothing
// from the device is on screen, and the hydration, sync and reminders wait
// for the answer (lib/adoptionGate.ts). The ways out are Keep, Discard, or
// Sign out, which leaves the device's data as it is for whoever kept it.
// Escape and the Android back button do nothing here.
export default function AdoptionPrompt() {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const user = useSessionStore((s) => s.user);
  const signOut = useSessionStore((s) => s.signOut);
  const syncNow = useSyncStore((s) => s.syncNow);
  const refreshPending = useSyncStore((s) => s.refreshPending);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  // v1.18.1 — the data is another account's or a guest's when the device's
  // last account is someone else: say so, rather than "from before signing in".
  // Read once, so the text does not change under the user while an answer runs.
  const [isSwitch] = useState(() => {
    const last = readLastUserId();
    return last !== null && last !== useSessionStore.getState().user?.id;
  });

  // v1.18.1 — a back-button listener replaces Capacitor's default back action
  // (history back, or leaving the app); this one keeps the question on screen.
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    const back = CapacitorApp.addListener('backButton', () => {});
    return () => {
      void back.then((h) => h.remove());
    };
  }, []);

  if (!user) return null;

  const onKeep = async () => {
    setBusy(true);
    setFailed(false);
    try {
      await keepLocalData(user.id);
      // The sync's `online` and 30 s triggers only fire when they see queued
      // rows, and offline nothing refreshes that count — so without this,
      // rows queued offline waited for the next launch to go up.
      void refreshPending();
      // v1.19 — NCC#139: not awaited; offline it would never finish. The
      // queue pushes whenever the sync can run.
      void syncNow();
    } catch (e) {
      console.warn('[adoption] keep failed:', (e as Error).message);
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  const onDiscard = async () => {
    if (!(await confirm({ message: t('common.wipeTestData') }))) return;
    setBusy(true);
    setFailed(false);
    try {
      await discardLocalData(user.id);
      // Reload so all stores re-init with the empty DB.
      window.location.reload();
    } catch (e) {
      console.warn('[adoption] discard failed:', (e as Error).message);
      setFailed(true);
      setBusy(false);
    }
  };

  const onSignOut = async () => {
    setBusy(true);
    setFailed(false);
    try {
      await signOut();
      // Same as Settings' sign-out: every store starts again from the device.
      window.location.reload();
    } catch (e) {
      console.warn('[adoption] sign-out failed:', (e as Error).message);
      setFailed(true);
      setBusy(false);
    }
  };

  return (
    <div
      className="min-h-full bg-bg text-text flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="adoption-title"
    >
      <div className="card-elevated max-w-sm w-full">
        <h2 id="adoption-title" className="font-heading font-bold text-lg mb-2">{t('adoption.title')}</h2>
        <p className="text-sm text-text-muted mb-4">{t(isSwitch ? 'adoption.switchBody' : 'adoption.body')}</p>
        <div className="space-y-2">
          <button onClick={onKeep} disabled={busy} className="btn w-full">
            {busy ? t('adoption.working') : t('adoption.keep')}
          </button>
          <button onClick={onDiscard} disabled={busy} className="btn-ghost w-full text-danger border-danger/40">
            {t('adoption.discard')}
          </button>
          <button onClick={onSignOut} disabled={busy} className="btn-ghost w-full">
            {t('settings.signOut')}
          </button>
        </div>
        {failed && (
          <p role="alert" className="text-sm text-danger mt-3 text-center">
            {t('adoption.failed')}
          </p>
        )}
        {/* v1.1 — UI/UX review #6: 10px → 11px on a legal-flavored disclosure. */}
        <p className="text-[0.6875rem] text-text-muted mt-3 text-center">
          {t(isSwitch ? 'adoption.switchFooter' : 'adoption.footer')}
        </p>
      </div>
    </div>
  );
}
