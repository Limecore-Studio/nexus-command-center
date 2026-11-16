import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { clearPin } from '../lib/clearPin';
import { useSessionStore } from '../store/useSessionStore';
import { authenticateBiometric } from '../utils/biometric';
import { clearAllLocalData } from '../db/database';
import '../i18n/lazy/pin'; // lock.forgot* (loaded with this panel)

// v1.21.1 (NCC#259) — "Forgot PIN?" on the lock screen leads somewhere.
//
// It used to point at Settings → Clear All Data, which sits behind the lock,
// and that did not remove the PIN anyway. Two ways out now, both reachable
// while locked:
// - Biometric, where it is on and available: proves it is the owner, so the
//   PIN is removed and the lock screen asks for a new one. Nothing is erased.
// - Erase this device: everything stored here goes, the PIN goes, and the
//   account is signed out, so the erase cannot be used to get past the lock
//   into the account's synced data. Synced data returns on the next sign-in.
//   Two taps, because unsynced changes are lost.
export default function ForgotPinPanel({ bioReady, onClose }: { bioReady: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const viaBiometric = async () => {
    setError(null);
    const result = await authenticateBiometric();
    if (!result.ok) {
      if (result.reason) setError(result.reason);
      return;
    }
    await clearPin(); // LockScreen switches to "set a new PIN"
    onClose();
  };

  const erase = async () => {
    if (!armed) {
      setArmed(true);
      return;
    }
    setBusy(true);
    try {
      await clearAllLocalData();
    } catch {
      /* keep going: the PIN and the session must still go */
    }
    // Signs out on this device even offline (useSessionStore.signOut).
    await useSessionStore.getState().signOut().catch(() => undefined);
    await clearPin();
    try {
      localStorage.clear();
    } catch {
      /* nothing stored */
    }
    location.reload();
  };

  return (
    <div
      className="fixed inset-0 bg-bg/90 z-[60] flex items-end sm:items-center justify-center p-4 safe-bottom"
      role="dialog"
      aria-modal="true"
      aria-labelledby="fp-title"
      onClick={busy ? undefined : onClose}
    >
      <div className="card-elevated w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
        <h2 id="fp-title" className="font-heading font-bold text-base">{t('lock.forgotTitle')}</h2>

        {bioReady && (
          <div className="mt-3">
            <p className="text-sm text-text-muted">{t('lock.forgotBioBody')}</p>
            <button type="button" className="btn w-full mt-2" onClick={viaBiometric} disabled={busy}>
              {t('lock.forgotBio')}
            </button>
          </div>
        )}

        <div className={bioReady ? 'mt-4 pt-4 border-t border-border' : 'mt-3'}>
          <p className="text-sm text-text-muted">{t('lock.forgotEraseBody')}</p>
          <button
            type="button"
            className={`w-full mt-2 px-4 py-2 text-sm rounded-md font-medium ${armed ? 'bg-danger text-white' : 'btn-ghost text-danger border-danger/40'}`}
            onClick={erase}
            disabled={busy}
          >
            {busy ? t('lock.forgotErasing') : armed ? t('lock.forgotEraseConfirm') : t('lock.forgotErase')}
          </button>
        </div>

        {error && <div className="text-xs text-danger mt-3">{error}</div>}

        <div className="flex justify-end mt-4">
          <button type="button" className="btn-ghost px-4 py-2 text-sm" onClick={onClose} disabled={busy}>
            {t('common.back')}
          </button>
        </div>
      </div>
    </div>
  );
}
