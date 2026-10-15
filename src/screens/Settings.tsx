import { useEffect, useState } from 'react';
import { useConfirm } from '../components/ConfirmDialog';
import { currencyOptions } from '../lib/currencies';
import { formatLocale } from '../utils/formatters';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { type Lang } from '../i18n';
import LanguageGrid from '../components/LanguageGrid';
import AppHeader from '../components/AppHeader';
import ListRow from '../components/ListRow';
import ChangeEmail from '../components/ChangeEmail';
import { useLifeProfileStore } from '../store/useLifeProfileStore';
import { enabledDomains } from '../lib/lifeProfile';
import pkg from '../../package.json';
import { Capacitor } from '@capacitor/core';
import { useAuthStore } from '../store/useAuthStore';
import { APP_LOCK_APPLIES } from '../lib/isDesktop';
import { IS_DESKTOP } from '../lib/desktop';
import { checkForDesktopUpdate, runDesktopUpdateAction, useDesktopUpdate } from '../lib/desktopUpdate';
import { setUpdateCheckEnabled, useFdroidUpdate } from '../lib/fdroidUpdate';
import { useSyncStore } from '../store/useSyncStore';
import { useSessionStore, userDisplayName } from '../store/useSessionStore';
import { listPending } from '../db/syncQueue';
import { useSettingsStore, BaseCurrency, UI_SCALES } from '../store/useSettingsStore';
import { useShellTier } from '../lib/useShell';
import { clearAllLocalData } from '../db/database';
import { setErrorReportsEnabled, useErrorReportsEnabled } from '../lib/errorReports';
import { biometricCapability } from '../utils/biometric';
import { supabase } from '../lib/supabase';
import { withCaptcha } from '../lib/captcha';
import { setGuestMode } from '../lib/guestMode';
import ThemePicker from '../components/ThemePicker';
import { Section, Toggle } from './settings/parts';
import NotificationsSection from './settings/NotificationsSection';
import FeedbackSection from './settings/FeedbackSection';
import { ApiKeysSection, ApiUsageSection } from './settings/ApiSections';
import YourDataSection from './settings/YourDataSection';

// Auto-lock intervals. The "Never" option was removed deliberately — leaving
// a phone permanently unlocked defeats the purpose of the PIN/biometric gate.
// 60-min cap is the longest sane idle window for an app holding financial,
// academic, and health data.
const autoLockOptions = [1, 5, 15, 30, 60];

export default function Settings() {
  const confirm = useConfirm();
  const navigate = useNavigate();
  const { t, i18n } = useTranslation();
  const currentLang = (i18n.language || 'en').split('-')[0] as Lang;
  const lifeProfile = useLifeProfileStore((s) => s.profile);
  const biometricEnabled = useAuthStore((s) => s.biometricEnabled);
  const setBiometric = useAuthStore((s) => s.setBiometric);
  const autoLock = useAuthStore((s) => s.autoLockMinutes);
  const setAutoLock = useAuthStore((s) => s.setAutoLock);
  const lock = useAuthStore((s) => s.lock);
  const verifyPin = useAuthStore((s) => s.verifyPin);
  const hasPin = useAuthStore((s) => s.hasPin);

  const user = useSessionStore((s) => s.user);
  const signOut = useSessionStore((s) => s.signOut);

  const baseCurrency = useSettingsStore((s) => s.baseCurrency);
  const setBaseCurrency = useSettingsStore((s) => s.setBaseCurrency);
  // v1.9 — text size. `autoScale` mirrors the tier default in index.css, so
  // the Auto swatch previews what Auto will actually give you here.
  const uiScale = useSettingsStore((s) => s.uiScale);
  const setUiScale = useSettingsStore((s) => s.setUiScale);
  const autoScale = useShellTier() === 'desktop' ? 1.2 : 1;
  const aiEnabled = useSettingsStore((s) => s.aiEnabled);
  const setAiEnabled = useSettingsStore((s) => s.setAiEnabled);

  const isOnline = useSyncStore((s) => s.isOnline);
  const lastSyncedAt = useSyncStore((s) => s.lastSyncedAt);
  const pendingCount = useSyncStore((s) => s.pendingCount);
  const syncNow = useSyncStore((s) => s.syncNow);
  const syncing = useSyncStore((s) => s.syncing);

  const lastError = useSyncStore((s) => s.lastError);
  const itemErrors = useSyncStore((s) => s.itemErrors);
  const refreshPending = useSyncStore((s) => s.refreshPending);
  const [bioAvailable, setBioAvailable] = useState(false);
  const [bioReason, setBioReason] = useState('');
  const [signOutOpen, setSignOutOpen] = useState(false);
  const [signOutBusy, setSignOutBusy] = useState(false);
  // v1.18.1 (NCC#140): what the sign-out choice decides about. This user's
  // unsynced edits stay on the device under "Keep local data" (and go up at
  // their next sign-in here); a wipe deletes them. The dialog used to say
  // nothing about them, and sign-out deleted them either way.
  const [unsentCount, setUnsentCount] = useState(0);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  useEffect(() => {
    if (!signOutOpen) return;
    let cancelled = false;
    void listPending()
      .then((items) => {
        if (!cancelled) setUnsentCount(items.filter((q) => q.owner === user?.id).length);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [signOutOpen, user?.id]);

  useEffect(() => {
    biometricCapability().then((c) => {
      setBioAvailable(c.available);
      setBioReason(c.reason);
    });
    void refreshPending();
  }, [refreshPending]);

  const onClearAll = async () => {
    if (!(await confirm({ message: t('settings.clearAllConfirm') }))) return;
    // PIN re-entry gate. Without this, briefly-unlocked devices left in
    // someone else's hands could be nuked by a single tap. We require the PIN
    // even though the user has already unlocked the app in this session.
    // `hasPin` can still be true on a desktop install that set one before the
    // lock was removed. Prompting there would demand a PIN the user can no
    // longer see, change, or reset from Settings — turning a forgotten one into
    // a permanent block on the very control that recovers from it.
    if (hasPin && APP_LOCK_APPLIES) {
      const entered = window.prompt(t('settings.pinReentry'));
      if (!entered) return;
      const result = await verifyPin(entered);
      if (!result.ok) {
        if (result.locked) {
          alert(t('settings.wipeLocked', { n: result.locked.remainingSeconds }));
        } else {
          alert(t('settings.wrongPin'));
        }
        return;
      }
    }
    await clearAllLocalData();
    localStorage.clear();
    location.reload();
  };

  // Two sign-out modes. Keeping local data is faster on next sign-in (no
  // re-pull); wiping is the right choice on shared/borrowed devices.
  const doSignOut = async (wipe: boolean) => {
    setSignOutBusy(true);
    setSignOutError(null);
    try {
      await signOut();
      if (wipe) {
        await clearAllLocalData();
        localStorage.clear();
      }
      location.reload();
    } catch (e) {
      // v1.18.1 (NCC#140): said, not swallowed. The dialog stays open.
      setSignOutError((e as Error)?.message || String(e));
    } finally {
      setSignOutBusy(false);
    }
  };

  const onChangePassword = async () => {
    if (!user?.email) return;
    const { error } = await withCaptcha((captchaToken) =>
      supabase.auth.resetPasswordForEmail(user.email!, { captchaToken }));
    if (error) {
      alert(t('settings.pwResetFail', { msg: error.message }));
    } else {
      alert(t('settings.pwResetSent'));
    }
  };

  const onForceResync = async () => {
    if (!user) return;
    if (!(await confirm({ message: t('settings.forceResyncConfirm') }))) return;
    const { adoptLocalData } = await import('../lib/cloudSync');
    await adoptLocalData(user.id);
    await refreshPending();
    await syncNow();
  };

  const lastSyncDisplay = lastSyncedAt
    ? new Intl.DateTimeFormat(formatLocale(), { hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' }).format(new Date(lastSyncedAt))
    : '—';

  return (
    <>
      <AppHeader title={t('settings.title')} showAvatar={false} />
      <div className="space-y-3">
        <Section title={t('settings.account')}>
          {user ? (
            <>
              <ListRow label={t('settings.name')} value={userDisplayName(user) || '—'} />
              <ListRow label={t('settings.email')} value={user?.email ?? '—'} />
              <button
                className="btn-ghost w-full mt-2"
                onClick={onChangePassword}
                disabled={!user?.email}
              >
                {t('settings.sendPwReset')}
              </button>
              {/* v1.17 (limecore#10): email/password accounts only. */}
              <ChangeEmail user={user} />
              <button
                className="btn-ghost w-full mt-2 text-danger border-danger/40"
                onClick={() => (setSignOutError(null), setUnsentCount(0), setSignOutOpen(true))}
              >
                {t('settings.signOut')}
              </button>
            </>
          ) : (
            <>
              {/* Guest mode — surface an upgrade-to-cloud-sync affordance.
                  Tapping clears the guestMode flag and reloads; App.tsx
                  re-routes to the Login screen since `session` is still
                  null. Local Dexie data is preserved (the AdoptionPrompt
                  on Login → app re-entry handles the keep-or-discard
                  choice when the user signs in). */}
              <ListRow label={t('settings.status')} value={t('settings.guestStatus')} />
              <p className="text-xs text-text-muted mt-1 mb-3 leading-relaxed">
                {t('settings.guestBlurb')}
              </p>
              <button
                className="btn w-full"
                onClick={async () => {
                  await setGuestMode(false);
                  window.dispatchEvent(new CustomEvent('nexus:guest-mode-changed'));
                  // App.tsx's gate will re-evaluate and route to Login since
                  // !session && !guestMode is now true. No reload needed —
                  // the CustomEvent listener triggers a state update which
                  // causes the gate's conditional to flip.
                }}
              >
                {t('settings.signIn')}
              </button>
            </>
          )}
        </Section>

        {/* The app lock is a phone control and is not part of the desktop
            build — see `App.tsx` for why. Hiding the section rather than
            disabling the controls: a greyed-out PIN row invites the question
            "why can't I turn this on", and there is no answer that helps. */}
        {APP_LOCK_APPLIES && (
        <Section title={t('settings.security')}>
          <Toggle
            label={t('settings.biometricUnlock')}
            sub={bioAvailable ? t('settings.biometricSub') : bioReason || t('settings.biometricUnavail')}
            value={biometricEnabled && bioAvailable}
            onChange={setBiometric}
            locked={!bioAvailable}
          />
          <Toggle
            label={t('settings.pinFallback')}
            sub={t('settings.pinFallbackSub')}
            value={true}
            onChange={() => {}}
            locked
          />
          <div className="py-2 flex items-center justify-between gap-2">
            <div>
              <div className="text-sm">{t('settings.autoLock')}</div>
              <div className="text-[0.625rem] text-text-muted">{t('settings.autoLockSub')}</div>
            </div>
            <select
              className="input max-w-[220px] py-2"
              value={autoLock}
              onChange={(e) => setAutoLock(Number(e.target.value))}
            >
              {autoLockOptions.map((m) => (
                <option key={m} value={m}>
                  {m === 0 ? t('settings.never') : t('settings.minShort', { n: m })}
                </option>
              ))}
            </select>
          </div>
          <Toggle
            label={t('settings.encryption')}
            sub={t('settings.encryptionSub')}
            value={true}
            onChange={() => {}}
            locked
          />
          <button
            className="btn-ghost w-full mt-2"
            onClick={lock}
          >
            {t('settings.lockNow')}
          </button>
        </Section>
        )}

        <Section title={t('settings.dataSync')}>
          <ListRow
            label={t('settings.cloudSync')}
            value={user ? (isOnline ? t('settings.active') : t('settings.offline')) : t('settings.notSignedIn')}
            tag={{ text: 'Supabase', tone: 'green' }}
          />
          <Toggle
            label={t('settings.offlineMode')}
            sub={t('settings.offlineModeSub')}
            value={true}
            onChange={() => {}}
            locked
          />
          <ListRow label={t('settings.lastSync')} value={lastSyncDisplay} />
          <ListRow
            label={t('settings.pendingWrites')}
            value={pendingCount === 0 ? t('settings.upToDate') : t('settings.queued', { n: pendingCount })}
          />
          {lastError && (
            <div className="alert alert-warn text-xs mt-2">
              <span className="w-2 h-2 rounded-full bg-danger" />
              <span className="flex-1">{lastError}</span>
            </div>
          )}
          {itemErrors.length > 0 && (
            <div className="text-[0.625rem] text-text-muted mt-1 space-y-0.5 font-mono">
              {itemErrors.map((e, i) => (
                <div key={i} className="truncate">
                  · {e.entityType}: {e.message}
                </div>
              ))}
            </div>
          )}
          <button
            className="btn-ghost w-full mt-2"
            onClick={syncNow}
            disabled={!isOnline || syncing}
          >
            {syncing ? t('settings.syncing') : isOnline ? t('settings.syncNow') : t('settings.offline')}
          </button>
          <button
            className="btn-ghost w-full mt-2"
            onClick={onForceResync}
            disabled={!user || !isOnline || syncing}
          >
            {t('settings.forceResync')}
          </button>
        </Section>

        <Section title={t('settings.preferences')}>
          <div className="py-2 flex items-center justify-between gap-2">
            <div>
              <div className="text-sm">{t('settings.baseCurrency')}</div>
              <div className="text-[0.625rem] text-text-muted">{t('settings.baseCurrencySub')}</div>
            </div>
            <select
              className="input max-w-[120px] py-2"
              value={baseCurrency}
              onChange={(e) => setBaseCurrency(e.target.value as BaseCurrency)}
            >
              {currencyOptions(formatLocale()).map((c) => (
                <option key={c.code} value={c.code}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
        </Section>

        {/* v1.15 (Item 13) — NCC had no Appearance section at all; Rack is
            the first thing to put in it. */}
        <Section title={t('settings.appearance')}>
          <ThemePicker />
        </Section>

        <Section title={t('settings.privacy')}>
          {/* Master switch for the cloud AI features. Off by default: the Life
              narrative previously generated on arrival at the tab, so "opt-in"
              was only true of the other two apps in the suite. */}
          <Toggle
            label={t('settings.aiFeatures')}
            sub={aiEnabled ? t('settings.aiFeaturesOnSub') : t('settings.aiFeaturesOffSub')}
            value={aiEnabled}
            onChange={setAiEnabled}
          />
          {/* Free-tier disclosure. Consent has to be informed where it is
              given, so this sits on the switch and not only in the policy. */}
          <div className="text-[0.625rem] text-text-muted px-1 pb-1 leading-relaxed">
            {t('settings.aiTrainingNote')}
          </div>
          {/* v1.16 (limecore#16) — off by default, accounts only; the note is
              the consent text the privacy policy (#50) relies on. */}
          <ErrorReportsToggle />
          <a
            className="py-2 flex items-center justify-between gap-3 active:opacity-80"
            href="https://limecore.dev/privacy"
            target="_blank"
            rel="noopener noreferrer"
          >
            <div className="min-w-0">
              <div className="text-sm">{t('settings.privacyPolicy')}</div>
              <div className="text-[0.625rem] text-text-muted">{t('settings.privacyPolicySub')}</div>
            </div>
            <span className="text-text-muted text-lg flex-shrink-0">›</span>
          </a>
        </Section>

        {/* ── Your data — GDPR Art. 17 / 20 ──────────────────────────────
             Buttons rather than a "write to us" address: a right the user has
             to request is a right most of them never exercise. */}
        <YourDataSection />

        {/* ── Support ────────────────────────────────────────────────────
             A link out, nothing more. No entitlements, no supporter-only
             features, no webhook — so nothing here can gate the app or
             change behaviour for someone who doesn't click it. */}
        <Section title={t('settings.support')}>
          <a
            className="py-2 flex items-center justify-between gap-3 active:opacity-80"
            href="https://ko-fi.com/limecorestudio"
            target="_blank"
            rel="noopener noreferrer"
          >
            <div className="min-w-0">
              <div className="text-sm">{t('settings.supportDev')}</div>
              <div className="text-[0.625rem] text-text-muted">{t('settings.supportDevSub')}</div>
            </div>
            <span className="text-text-muted text-lg flex-shrink-0">›</span>
          </a>
          {/* Sits next to Ko-fi rather than in its own section because the two
              are about to be connected: Ko-fi's own Discord bot maps a
              membership tier onto a Discord role. Same shape as the row above
              — an ordinary outbound link, no SDK, no embed, nothing loaded
              from discord.com unless the user taps it. */}
          <a
            className="py-2 flex items-center justify-between gap-3 active:opacity-80"
            href="https://discord.gg/g8VuB4yXHY"
            target="_blank"
            rel="noopener noreferrer"
          >
            <div className="min-w-0">
              <div className="text-sm">{t('settings.discord')}</div>
              <div className="text-[0.625rem] text-text-muted">{t('settings.discordSub')}</div>
            </div>
            <span className="text-text-muted text-lg flex-shrink-0">›</span>
          </a>
        </Section>

        {/* ── Feedback ───────────────────────────────────────────────────
             MOVED UP in v1.13, from fourteenth of fifteen sections to third
             from the top — directly under Support.

             The v1.13 build plan asks an open question: NCC has 106 signups,
             60 within a fortnight, and has never produced a single feedback
             row or GitHub issue in its life, while StudyDesk has twelve. Its
             two candidate answers are "the form isn't reachable there" and
             "nobody is engaged enough to use it", and it notes those "point
             at completely different work".

             Checking the source settles the first: the form is here, it is
             complete, and its submit handler has no silent `return` — every
             guard sets a visible notice. So it works.

             But it was sitting BELOW "API keys" and "API usage today", at the
             bottom of a ~1000-line settings screen, behind two sections that
             only matter to someone who has wired up their own API key. A
             feature nobody scrolls to is not meaningfully more reachable than
             one that does not exist, and "no feedback rows" is a much weaker
             signal about engagement when the form is that far down.

             This does not prove placement was the cause. It removes the
             cheapest confound, so the next reading of that table means
             something. ── */
        }
        <FeedbackSection />


        <Section title={t('settings.lifeProfile')}>
          <button
            className="w-full py-2 flex items-center justify-between gap-3 text-start active:opacity-80"
            onClick={() => navigate('/settings/life-profile')}
          >
            <div className="min-w-0">
              <div className="text-sm">{t(`lifeProfile.${lifeProfile.preset}`)}</div>
              <div className="text-[0.625rem] text-text-muted truncate">
                {enabledDomains(lifeProfile)
                  .map((k) => `${t(`domains.${k}`)} ${lifeProfile.domains[k]}%`)
                  .join(' · ')}
              </div>
            </div>
            <span className="text-text-muted text-lg flex-shrink-0">›</span>
          </button>
          <div className="text-[0.625rem] text-text-muted px-1 pb-1">
            {t('settings.lifeProfileBlurb')}
          </div>
        </Section>

        <Section title={t('settings.language')}>
          <LanguageGrid current={currentLang} variant="settings" />
        </Section>

        {/* v1.9 — text size. The type is sized for a phone at arm's length and
            reads small on a monitor, so desktop already defaults larger; this
            is the escape hatch in both directions. Each option previews itself
            at its own scale, because a row of identical labels reading
            "Larger" tells you nothing about what you are choosing. */}
        <Section title={t('settings.textSize')}>
          <div className="grid grid-cols-3 gap-2 py-1">
            {UI_SCALES.map((s) => {
              const active = uiScale === s;
              return (
                <button
                  key={s}
                  type="button"
                  onClick={() => void setUiScale(s)}
                  aria-pressed={active}
                  className={`rounded-md border px-2 py-2 flex flex-col items-center justify-center gap-0.5 transition-colors ${
                    active
                      ? 'border-primary/60 bg-primary/10 text-primary'
                      : 'border-border text-text-muted active:bg-surface2/60'
                  }`}
                >
                  <span
                    aria-hidden
                    className="font-heading leading-none"
                    // Previews at the scale it sets. `auto` shows the tier
                    // default rather than a made-up middle value.
                    style={{ fontSize: `${(s === 'auto' ? autoScale : Number(s)) * 0.875}rem` }}
                  >
                    Aa
                  </span>
                  <span className="text-[0.625rem] uppercase tracking-wider">
                    {s === 'auto' ? t('settings.textAuto') : `${Math.round(Number(s) * 100)}%`}
                  </span>
                </button>
              );
            })}
          </div>
          <div className="text-[0.625rem] text-text-muted px-1 pb-1">
            {uiScale === 'auto' ? t('settings.textAutoSub', { pct: Math.round(autoScale * 100) }) : t('settings.textSizeSub')}
          </div>
        </Section>

        <NotificationsSection />

        <ApiKeysSection />

        <ApiUsageSection />

        <Section title={t('settings.about')}>
          <ListRow label={t('settings.version')} value={pkg.version} />
          {IS_DESKTOP && <DesktopUpdateRow />}
          {Capacitor.getPlatform() === 'android' && <FdroidUpdateToggle />}
          <ListRow label={t('settings.studio')} value="Limecore" />
          <ListRow label={t('settings.build')} value={t('settings.buildValue')} />
          <button
            className="btn-ghost w-full mt-2 text-danger border-danger/40"
            onClick={onClearAll}
          >
            {t('settings.clearAllData')}
          </button>
        </Section>
      </div>
      {signOutOpen && createPortal(
        <div className="fixed inset-0 bg-bg/90 z-50 flex items-center justify-center p-4">
          <div className="card-elevated max-w-sm w-full max-h-[90vh] overflow-y-auto">
            <h2 className="font-heading font-bold text-base mb-1">{t('settings.signOutTitle')}</h2>
            <p className="text-xs text-text-muted mb-4">
              {t('settings.signOutBlurb')}
            </p>
            {unsentCount > 0 && (
              <p className="text-xs text-warning mb-4">{t('settings.signOutUnsynced', { count: unsentCount })}</p>
            )}
            {signOutError && (
              <p className="text-xs text-danger mb-4" role="alert">{t('settings.signOutFailed', { msg: signOutError })}</p>
            )}
            <div className="space-y-2">
              <button
                className="btn w-full"
                disabled={signOutBusy}
                onClick={() => doSignOut(false)}
              >
                {signOutBusy ? t('settings.working') : t('settings.keepLocal')}
              </button>
              <p className="text-[0.625rem] text-text-muted -mt-1 px-1">
                {t('settings.keepLocalSub')}
              </p>
              <button
                className="btn-ghost w-full text-danger border-danger/40"
                disabled={signOutBusy}
                onClick={() => doSignOut(true)}
              >
                {t('settings.wipeLocal')}
              </button>
              <p className="text-[0.625rem] text-text-muted -mt-1 px-1">
                {t('settings.wipeLocalSub')}
              </p>
              <button
                className="btn-ghost w-full"
                disabled={signOutBusy}
                onClick={() => setSignOutOpen(false)}
              >
                {t('common.cancel')}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

// v1.15 (Item 12) — the Settings half of desktop updates. With nothing known
// yet, tapping re-asks GitHub (skipping the once-per-launch cache). Once a
// newer release is known it downloads it, then installs it; when the updater
// cannot take that release, it opens the release page instead.
function DesktopUpdateRow() {
  const { t } = useTranslation();
  const update = useDesktopUpdate();
  const { status, canInstall } = update;
  const pending = status === 'available' || status === 'downloading' || status === 'ready';
  const value =
    status === 'checking' ? t('settings.updateChecking')
    : status === 'downloading' ? t('settings.updateDownloading', { percent: update.percent })
    : status === 'ready' ? t('settings.updateRestart')
    : status === 'available' ? (canInstall ? t('settings.updateDownload') : t('settings.updateOpen'))
    : status === 'current' ? t('settings.updateCurrent')
    : status === 'error' ? t('settings.updateFailed')
    : t('settings.updateCheck');
  const busy = status === 'checking' || status === 'downloading';
  return (
    <ListRow
      label={t('settings.updates')}
      value={value}
      tag={pending ? { text: `v${update.latest}`, tone: 'green' } : undefined}
      onClick={busy ? undefined : pending ? runDesktopUpdateAction : () => checkForDesktopUpdate(true)}
    />
  );
}

// v1.16 (#48) — the switch the privacy policy promises (#50): off stops the
// once-a-day request to f-droid.org entirely, not merely the note. Android
// only, because it is the only build F-Droid ships.
function FdroidUpdateToggle() {
  const { t } = useTranslation();
  const { enabled } = useFdroidUpdate();
  return (
    <Toggle
      label={t('settings.fdroidCheck')}
      sub={t('settings.fdroidCheckNote')}
      value={enabled}
      onChange={setUpdateCheckEnabled}
    />
  );
}

function ErrorReportsToggle() {
  const { t } = useTranslation();
  const on = useErrorReportsEnabled();
  return (
    <>
      <Toggle label={t('settings.errorReports')} sub={t('settings.errorReportsSub')} value={on} onChange={setErrorReportsEnabled} />
      <div className="text-[0.625rem] text-text-muted px-1 pb-1 leading-relaxed">{t('settings.errorReportsNote')}</div>
    </>
  );
}
