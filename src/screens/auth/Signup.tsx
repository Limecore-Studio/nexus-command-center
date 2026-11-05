import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Trans, useTranslation } from 'react-i18next';
import { supabase } from '../../lib/supabase';
import { translateAuthError } from '../../lib/authErrors';
import { withCaptcha } from '../../lib/captcha';
import { meetsPasswordRule, PASSWORD_MIN_LENGTH } from '../../lib/passwordPolicy';
import { PasswordChecklist } from '../../components/PasswordChecklist';

// AUTH-2 — confirmation-code bounds, ported from StudyDesk's AuthGate.
//
// Supabase's Mailer OTP Length is a project setting with a documented range of
// 6-10, and this project emits 8. The range is accepted on purpose: StudyDesk's
// first version assumed 6, which left the input physically unable to hold a
// valid code (fixed in 1.6.2), and pinning it to 8 would only defer the same
// failure to the next time that setting changes.
const OTP_MIN = 6;
const OTP_MAX = 10;

const RESEND_COOLDOWN_S = 60;

export default function Signup() {
  const { t } = useTranslation();
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pwFlag, setPwFlag] = useState(false); // limecore#73: a submit failed on the rule
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [otpCode, setOtpCode] = useState('');
  const [info, setInfo] = useState<string | null>(null);
  const [resendIn, setResendIn] = useState(0);

  // Resend cooldown. Interval rather than a timeout chain so a re-render can't
  // orphan a pending tick, and it clears itself the moment the count hits 0.
  useEffect(() => {
    if (resendIn <= 0) return;
    const id = setInterval(() => setResendIn((s) => (s <= 1 ? 0 : s - 1)), 1000);
    return () => clearInterval(id);
  }, [resendIn]);

  const onVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setInfo(null);
    const token = otpCode.replace(/\D/g, '');
    // Deliberately a lower bound, not an exact length — see OTP_MIN above. The
    // server is the authority on whether a plausible-looking code is correct.
    if (token.length < OTP_MIN) {
      setError(t('auth.errOtpLength'));
      return;
    }
    setSubmitting(true);
    const { error: err } = await supabase.auth.verifyOtp({
      email: email.trim(),
      token,
      type: 'signup',
    });
    setSubmitting(false);
    // On success the auth state change propagates and the app swaps the gate
    // out, so there is nothing to navigate to here.
    if (err) setError(translateAuthError(err, t) ?? t('auth.errOtp'));
  };

  const onResend = async () => {
    if (resendIn > 0 || submitting) return;
    setError(null);
    setInfo(null);
    setSubmitting(true);
    const { error: err } = await withCaptcha((captchaToken) =>
      supabase.auth.resend({ type: 'signup', email: email.trim(), options: { captchaToken } }));
    setSubmitting(false);
    if (err) setError(translateAuthError(err, t) ?? t('auth.errOtpResend'));
    else setInfo(t('auth.otpSent'));
    // Cooldown starts either way. The usual cause of a failure here is having
    // hit the server-side send interval, and re-enabling the button at once
    // just invites the same error again.
    setResendIn(RESEND_COOLDOWN_S);
  };

  const validate = (): string | null => {
    if (!fullName.trim()) return t('auth.errNameRequired');
    // v1.20 (limecore#73) — the server's rule, with its own symbol set: the
    // old /[^A-Za-z0-9]/ ticked an `ä` or a space the server then refused.
    if (!meetsPasswordRule(password)) {
      setPwFlag(true);
      return t('auth.pwNotYet');
    }
    if (password !== confirm) return t('auth.errPasswordMismatch');
    return null;
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const v = validate();
    if (v) {
      setError(v);
      return;
    }
    setSubmitting(true);
    const { error } = await withCaptcha((captchaToken) =>
      supabase.auth.signUp({
        email: email.trim(),
        password,
        options: {
          data: { full_name: fullName.trim() },
          captchaToken,
        },
      }));
    setSubmitting(false);
    if (error) {
      setError(translateAuthError(error, t));
      return;
    }
    setSent(true);
  };

  // AUTH-2 — the emailed link still works and is still described here; this
  // screen adds the code as a second way through. The same token backs both,
  // so there is no flag day and older emails keep working.
  if (sent) {
    return (
      <div className="min-h-full bg-bg text-text flex flex-col">
        <div className="flex-1 flex flex-col justify-center px-6 max-w-md mx-auto w-full">
          <h1 className="font-heading font-bold text-2xl tracking-tight mb-2">
            {t('auth.otpTitle')}
          </h1>
          <p className="text-sm text-text-muted mb-6">
            <Trans
              i18nKey="auth.checkEmailBody"
              values={{ email }}
              components={{ 1: <span className="text-text" /> }}
            />
          </p>

          <form onSubmit={onVerify} className="space-y-3">
            <div>
              <label className="block text-[0.625rem] uppercase tracking-wider text-text-muted mb-1">
                {t('auth.otpLabel')}
              </label>
              <input
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                className="input w-full text-center text-lg tracking-[0.3em] tabular-nums"
                /* Placeholder length tracks OTP_MAX rather than a literal, so
                   the field never advertises a digit count that has gone stale. */
                placeholder={'-'.repeat(OTP_MAX)}
                maxLength={OTP_MAX}
                value={otpCode}
                onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, '').slice(0, OTP_MAX))}
              />
            </div>

            {error && <div className="text-xs text-danger">{error}</div>}
            {info && <div className="text-xs text-success">{info}</div>}

            <button type="submit" className="btn w-full" disabled={submitting}>
              {submitting ? t('common.loading') : t('auth.otpSubmit')}
            </button>
          </form>

          <p className="text-[0.625rem] text-text-muted mt-3">{t('auth.otpHint')}</p>

          <button
            type="button"
            className="btn-ghost w-full mt-3"
            onClick={onResend}
            disabled={resendIn > 0 || submitting}
          >
            {resendIn > 0 ? `${t('auth.otpResendIn')} ${resendIn}s` : t('auth.otpResend')}
          </button>

          <Link to="/auth/login" className="btn-ghost w-full text-center mt-2">
            {t('auth.backToSignIn')}
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-full bg-bg text-text flex flex-col">
      <div className="flex-1 flex flex-col justify-center px-6 max-w-md mx-auto w-full">
        <div className="mb-8">
          <h1 className="font-heading font-bold text-3xl tracking-tight">
            {t('auth.createTitle')}
          </h1>
          {/* Product name — deliberately not a translation key. */}
          <p className="text-sm text-text-muted mt-1">Nexus Command Center</p>
        </div>

        <form onSubmit={onSubmit} className="space-y-3">
          <div>
            <label className="block text-[0.625rem] uppercase tracking-wider text-text-muted mb-1">
              {t('auth.fullNameLabel')}
            </label>
            <input
              type="text"
              autoComplete="name"
              required
              className="input w-full"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder={t('auth.fullNamePlaceholder')}
            />
          </div>
          <div>
            <label className="block text-[0.625rem] uppercase tracking-wider text-text-muted mb-1">
              {t('auth.emailLabel')}
            </label>
            <input
              type="email"
              autoComplete="email"
              required
              className="input w-full"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={t('auth.emailPlaceholder')}
            />
          </div>
          <div>
            <label className="block text-[0.625rem] uppercase tracking-wider text-text-muted mb-1">
              {t('auth.passwordLabel')}
            </label>
            <input
              type="password"
              autoComplete="new-password"
              required
              minLength={PASSWORD_MIN_LENGTH}
              aria-describedby="signup-pw-rules"
              className="input w-full"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={t('auth.passwordPlaceholder')}
            />
            <PasswordChecklist id="signup-pw-rules" password={password} flagMissing={pwFlag} />
          </div>
          <div>
            <label className="block text-[0.625rem] uppercase tracking-wider text-text-muted mb-1">
              {t('auth.confirmPasswordLabel')}
            </label>
            <input
              type="password"
              autoComplete="new-password"
              required
              minLength={PASSWORD_MIN_LENGTH}
              className="input w-full"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </div>

          {error && (
            <div className="alert alert-warn text-xs">
              <span className="w-2 h-2 rounded-full bg-danger" />
              <span>{error}</span>
            </div>
          )}

          <button type="submit" disabled={submitting} className="btn w-full">
            {submitting ? t('auth.creatingAccount') : t('auth.createAccount')}
          </button>
        </form>

        {/* GDPR Art. 8 — consent for an information society service is only
            valid from 16 (13 in some member states). We cannot verify ages and
            are not expected to, but the policy states the limit, so the signup
            form should too rather than leaving it somewhere nobody reads. It
            also points at the option that needs no account at all. */}
        <p className="text-[0.625rem] text-text-muted mt-6 leading-relaxed text-center">
          {t('auth.ageNote')}{' '}
          <a
            href="https://limecore.dev/privacy"
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary"
          >
            {t('auth.privacyLink')}
          </a>
        </p>

        <p className="text-center text-xs text-text-muted mt-6">
          {t('auth.haveAccount')}{' '}
          <Link to="/auth/login" className="text-primary">
            {t('auth.signIn')}
          </Link>
        </p>
      </div>
    </div>
  );
}
