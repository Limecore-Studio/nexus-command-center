import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '../store/useAuthStore';
import { authenticateBiometric } from '../utils/biometric';
import '../i18n/lazy/pin'; // settings.*Pin* (loaded with this dialog)

// v1.21.1 (NCC#259) — Settings > Security > Change PIN. Until now a PIN could
// only be set once, on the lock screen's first run. The current PIN (or the
// fingerprint, the same proof the lock screen accepts) comes first, then the
// new one twice. A wrong current PIN counts toward the lockout, as on the
// lock screen. Loaded on demand from Settings.
const SIX_DIGITS = /^\d{6}$/;

export default function ChangePinDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const verifyPin = useAuthStore((s) => s.verifyPin);
  const setPin = useAuthStore((s) => s.setPin);
  const biometricEnabled = useAuthStore((s) => s.biometricEnabled);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [bioOk, setBioOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const useFingerprint = async () => {
    setError(null);
    const r = await authenticateBiometric();
    if (r.ok) setBioOk(true);
    else if (r.reason) setError(r.reason);
  };

  const save = async () => {
    setError(null);
    if (!SIX_DIGITS.test(next)) return setError(t('settings.newPin'));
    if (next !== repeat) return setError(t('settings.pinsDiffer'));
    setBusy(true);
    try {
      if (!bioOk) {
        const r = await verifyPin(current);
        if (r.locked) return setError(t('lock.tooManyError', { secs: r.locked.remainingSeconds }));
        // A PIN this device can't read can't be checked; the fingerprint can.
        if (r.unreadable) return setError(t('lock.pinUnreadable'));
        if (!r.ok) return setError(t('lock.wrongPin'));
      }
      await setPin(next);
      setDone(true);
    } finally {
      setBusy(false);
    }
  };

  const pinInput = (value: string, set: (v: string) => void, label: string, autoFocus = false) => (
    <input
      className="input w-full mt-2 font-mono tracking-[0.3em]"
      type="password"
      inputMode="numeric"
      autoComplete="off"
      maxLength={6}
      aria-label={label}
      placeholder={label}
      value={value}
      autoFocus={autoFocus}
      onChange={(e) => set(e.target.value.replace(/\D/g, '').slice(0, 6))}
    />
  );

  return (
    <div
      className="fixed inset-0 bg-bg/90 z-[60] flex items-end sm:items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="cpin-title"
      onClick={busy ? undefined : onClose}
    >
      <div className="card-elevated w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
        <h2 id="cpin-title" className="font-heading font-bold text-base">{t('settings.changePin')}</h2>
        {done ? (
          <>
            <p className="text-sm text-text mt-3">{t('settings.pinChanged')}</p>
            <div className="flex justify-end mt-4">
              <button type="button" className="btn px-4 py-2 text-sm" onClick={onClose} autoFocus>
                {t('common.close')}
              </button>
            </div>
          </>
        ) : (
          <>
            {bioOk ? (
              <div className="alert alert-ok mt-3">✓</div>
            ) : (
              <>
                {pinInput(current, setCurrent, t('settings.currentPin'), true)}
                {biometricEnabled && (
                  <button type="button" className="btn-ghost btn-sm mt-2" onClick={useFingerprint} disabled={busy}>
                    {t('lock.forgotBio')}
                  </button>
                )}
              </>
            )}
            <div className="mt-3">
              {pinInput(next, setNext, t('settings.newPin'))}
              {pinInput(repeat, setRepeat, t('settings.repeatPin'))}
            </div>
            {error && <div className="text-xs text-danger mt-3">{error}</div>}
            <div className="flex justify-end gap-2 mt-4">
              <button type="button" className="btn-ghost px-4 py-2 text-sm" onClick={onClose} disabled={busy}>
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="btn px-4 py-2 text-sm"
                onClick={save}
                disabled={busy || next.length !== 6 || repeat.length !== 6 || (!bioOk && current.length !== 6)}
              >
                {t('common.save')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
