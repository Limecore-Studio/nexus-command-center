// First-launch sign-in surface for NCC. Order of options reflects the
// suite-wide auth UX model:
//
//   1. Continue with Google — primary path. NCC is the SSO source for the
//      suite (LimeLog + StudyDesk inherit from NCC via SessionContentProvider),
//      so the easier we make Google sign-in here, the smoother the
//      cross-app experience is.
//   2. Use email instead    — collapsed by default. Still fully supported,
//      just not the lead affordance.
//   3. Continue as guest    — bypass auth entirely. Sets a Preferences flag
//      so the next launch goes straight to the app. User can still sign in
//      later from Settings to enable Supabase sync.

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Browser } from '@capacitor/browser';
import { Capacitor } from '@capacitor/core';
import { supabase, OAUTH_REDIRECT_URL } from '../../lib/supabase';
import { desktop, DESKTOP_REDIRECT_URL } from '../../lib/desktop';
import { setGuestMode } from '../../lib/guestMode';
import { isOnboarded } from '../../lib/onboarding';
import { translateAuthError } from '../../lib/authErrors';
import { withCaptcha } from '../../lib/captcha';

export default function Login() {
  const { t } = useTranslation();
  // v1.8 / ACT-3 — the gate used to greet everyone with "Sign in", which reads
  // as "welcome back" to someone who has never opened the app. `isOnboarded()`
  // is set at the end of onboarding, which lives *behind* this gate, so at gate
  // time an unset flag is a sound "this device has never completed first run".
  // Read once on mount: the flag can't change while the gate is on screen, and
  // re-reading would let the copy shift under the user mid-session.
  const [firstRun] = useState(() => !isOnboarded());
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [googleSubmitting, setGoogleSubmitting] = useState(false);
  // v1.12.1 — a non-error status line. Desktop sign-in now completes in the
  // system browser, and a window that visibly does nothing after the click is
  // indistinguishable from one that failed.
  const [notice, setNotice] = useState<string | null>(null);
  const [showEmail, setShowEmail] = useState(false);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    // withCaptcha only involves hCaptcha if the server asks for it — see
    // lib/captcha.ts for why this is not a widget on the screen.
    const { error } = await withCaptcha((captchaToken) =>
      supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
        options: { captchaToken },
      }));
    setSubmitting(false);
    if (error) {
      setError(translateAuthError(error, t));
    }
    // On success, the session store listener will pick up the new session and
    // App.tsx will re-render away from this screen.
  };

  const onGoogle = async () => {
    setError(null);
    setNotice(null);
    // Desktop with no loopback listener: every candidate port was taken, so
    // DESKTOP_REDIRECT_URL is null and OAUTH_REDIRECT_URL has fallen back to
    // `nexus://app/` — the exact value this whole change exists to stop being
    // sent to Supabase. Left alone the round trip still *looks* like it works:
    // the browser opens, Google authenticates, Supabase rejects the redirect,
    // and the user lands on limecore.dev/confirmed with no session and no
    // error, while this screen sits on a notice waiting for a callback that
    // can never arrive. Refuse it up front and say why. Email sign-in needs no
    // redirect and is unaffected.
    if (desktop && !DESKTOP_REDIRECT_URL) {
      setError(t('auth.errDesktopNoListener'));
      return;
    }
    setGoogleSubmitting(true);
    try {
      const { data, error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: OAUTH_REDIRECT_URL,
          skipBrowserRedirect: true, // we control the browser ourselves
        },
      });
      if (error || !data?.url) {
        setError(translateAuthError(error, t) ?? t('auth.errGoogleStart'));
        setGoogleSubmitting(false);
        return;
      }
      if (Capacitor.isNativePlatform()) {
        await Browser.open({ url: data.url, presentationStyle: 'fullscreen' });
        // The deep-link listener in App.tsx will exchangeCodeForSession when
        // Google redirects back to our scheme.
      } else if (desktop?.beginOAuth) {
        // v1.12.1 — NEVER navigate the desktop window. It has no back button,
        // no address bar and no menu, so sending it to a provider is a one-way
        // trip: the redirect chain ended on limecore.dev/confirmed and the app
        // was gone. The system browser owns this leg; the loopback listener in
        // electron/main.cjs brings the code back and the handler in App.tsx
        // redeems it, where the PKCE verifier lives.
        const opened = await desktop.beginOAuth(data.url);
        if (!opened) {
          setError(t('auth.errGoogleStart'));
          setGoogleSubmitting(false);
          return;
        }
        setNotice(t('auth.desktopBrowser'));
      } else {
        // Web fallback — just navigate the current tab.
        window.location.href = data.url;
      }
    } catch (e) {
      setError(translateAuthError(e as Error, t));
    } finally {
      setGoogleSubmitting(false);
    }
  };

  const onGuest = async () => {
    // Mark this device as opting out of auth. App.tsx reads the flag and
    // skips the Login gate; the rest of the app runs on local Dexie state.
    // The user can sign in later from Settings (which will clear the flag).
    //
    // v1.1 — UI/UX review #3: write the flag FIRST, then dispatch the
    // change event so the listener observes the updated value on its
    // re-read. The previous order (navigate → dispatch) was a no-op until
    // the dispatch fired; now the gate flip is deterministic. No explicit
    // navigate needed — App.tsx re-renders to Dashboard once the gate
    // condition flips.
    setError(null);
    await setGuestMode(true);
    window.dispatchEvent(new CustomEvent('nexus:guest-mode-changed'));
  };

  return (
    <div className="min-h-full bg-bg text-text flex flex-col">
      {/* v1.9 Item 14 — Login renders outside AppShell (App.tsx returns it
          instead of the shell when there is no session), so none of the
          desktop shell work reached it and it stayed a 448px phone column.
          Scales per tier now, same treatment as LockScreen. Stays centred
          rather than going full-bleed: a sign-in form spread across 2560px
          would be worse, not better — it needed presence, not width. */}
      <div className="flex-1 flex flex-col justify-center px-6 max-w-md tablet:max-w-lg desktop:max-w-xl mx-auto w-full">
        {/* "Nexus" is the product name — deliberately not a translation key. */}
        <div className="mb-8 desktop:mb-12">
          <h1 className="font-heading font-bold text-3xl desktop:text-5xl tracking-tight">Nexus</h1>
          <p className="text-sm desktop:text-lg text-text-muted mt-1 desktop:mt-3">
            {firstRun ? t('auth.firstRunSubtitle') : t('auth.signInSubtitle')}
          </p>
          {/* ACT-3: on first run, lead with the local-first promise rather than
              an account pitch — this is the screen where "you don't need an
              account" has to land, and the guest control itself is the last
              thing on the page. */}
          {firstRun && (
            <p className="text-xs desktop:text-base text-text-muted mt-2">{t('auth.firstRunPromise')}</p>
          )}
        </div>

        {/* Primary affordance — Google. Suite-wide SSO source. */}
        <button
          type="button"
          onClick={onGoogle}
          disabled={googleSubmitting}
          className="btn w-full flex items-center justify-center gap-2 desktop:py-4 desktop:text-base"
        >
          <GoogleG />
          {googleSubmitting ? t('auth.googleOpening') : t('auth.google')}
        </button>

        {/* Email/password — secondary, collapsed by default.
            v1.1 — UI/UX review #1: was a text-only button (~18px tall).
            Now py-3 + w-full → 44px+ tap target while keeping the
            secondary visual treatment. */}
        {!showEmail ? (
          <button
            type="button"
            onClick={() => setShowEmail(true)}
            className="w-full text-center text-xs desktop:text-sm text-text-muted mt-3 py-3 underline-offset-2 hover:underline rounded-md"
          >
            {t('auth.useEmail')}
          </button>
        ) : (
          <>
            <div className="flex items-center gap-3 my-5">
              <div className="flex-1 h-px bg-border" />
              <span className="text-[0.625rem] uppercase tracking-wider text-text-muted">
                {t('auth.orUseEmail')}
              </span>
              <div className="flex-1 h-px bg-border" />
            </div>

            <form onSubmit={onSubmit} className="space-y-3">
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
                  autoComplete="current-password"
                  required
                  className="input w-full"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••••"
                />
              </div>

              <button type="submit" disabled={submitting} className="btn-ghost w-full">
                {submitting ? t('auth.signingIn') : t('auth.signInEmail')}
              </button>
            </form>

            <p className="text-center text-xs text-text-muted mt-4">
              {t('auth.noAccount')}{' '}
              <Link to="/auth/signup" className="text-primary">
                {t('auth.signUp')}
              </Link>
            </p>
          </>
        )}

        {error && (
          <div className="alert alert-warn text-xs mt-4">
            <span className="w-2 h-2 rounded-full bg-danger" />
            <span>{error}</span>
          </div>
        )}

        {notice && !error && (
          <div className="alert text-xs mt-4" role="status">
            <span>{notice}</span>
          </div>
        )}

        {/* Guest path — clearly last, but a real option. The line above it
            is visually distinct so it doesn't look like a third sign-in
            method. Caption explains the trade-off so the user knows what
            they're opting out of.
            v1.1 — UI/UX review #2: button was text-only (~20px tall).
            Now full-width with py-3 + min-h-[44px] to meet WCAG 2.5.5
            without losing the visually-tertiary treatment (no fill, no
            border — opt-out path stays clearly de-emphasized vs the
            sign-in CTAs above). #6: disclaimer bumped 10px → 11px. */}
        <div className="mt-10 pt-6 border-t border-border/60 flex flex-col items-center">
          <button
            type="button"
            onClick={onGuest}
            className="w-full min-h-[44px] py-3 text-sm text-text-muted hover:text-text underline-offset-2 hover:underline rounded-md"
          >
            {t('auth.guest')}
          </button>
          <p className="text-[0.6875rem] text-text-muted mt-1.5 text-center px-4 leading-relaxed">
            {t('auth.guestCaption')}
          </p>
        </div>
      </div>
    </div>
  );
}

function GoogleG() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M17.64 9.205c0-.639-.057-1.252-.164-1.841H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"
      />
      <path
        fill="#FBBC05"
        d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z"
      />
    </svg>
  );
}
