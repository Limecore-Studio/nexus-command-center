// First-launch (post-upgrade) explainer modal for notifications.
//
// Gated by `settings.notif.introSeen` — once dismissed (any path), never
// shown again on this device. The Settings → Notifications section is the
// permanent home for changing your mind.
//
// Three paths out:
//
//   "Enable Notifications"
//     → Calls ensureNotificationPermission() which talks to the native
//       LocalNotifications plugin. On grant: flips master + 4 categories
//       ON, marks seen, closes. On deny/error: shows the error in-modal
//       and lets the user retry, escape, or bypass.
//
//   "I already granted permission"
//     → Bypass path. Doesn't call the plugin at all — just flips master +
//       4 categories ON, marks seen, closes. The escape hatch for the case
//       where the plugin bridge is unreliable (rare Capacitor / plugin
//       version interactions can leave checkPermissions/requestPermissions
//       in a never-resolving state even when the OS perm is actually
//       granted). Only shown after the user has tried Enable once OR if we
//       can confirm via Capacitor's perm cache that the OS already granted.
//
//   "Not Now"
//     → Marks intro seen. All toggles stay off. Always clickable, even
//       while Enable is in flight — otherwise a hanging plugin would lock
//       the modal with no way out short of force-closing the app.
//
// Auto-skip: on mount, if we can confirm the OS permission is already
// granted (via a fast checkPermissions() call protected by a short
// timeout), we silently flip everything ON and mark seen — saves the user
// from even seeing the modal in the post-upgrade case where they already
// allowed notifications on a prior version.
//
// Only renders on native platforms. On web (dev) it's a no-op so we don't
// show a prompt that can't actually do anything.

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Capacitor } from '@capacitor/core';
import { useSettingsStore } from '../store/useSettingsStore';
import { ensureNotificationPermission, hasNotificationPermission } from '../lib/notifications';

export default function NotificationsExplainerModal() {
  const { t } = useTranslation();
  const loaded = useSettingsStore((s) => s.loaded);
  const introSeen = useSettingsStore((s) => s.notifIntroSeen);
  const setIntroSeen = useSettingsStore((s) => s.setNotifIntroSeen);
  const setNotifMasterEnabled = useSettingsStore((s) => s.setNotifMasterEnabled);
  const setNotifTasksEnabled = useSettingsStore((s) => s.setNotifTasksEnabled);
  const setNotifBudgetsEnabled = useSettingsStore((s) => s.setNotifBudgetsEnabled);
  const setNotifPortfolioEodEnabled = useSettingsStore((s) => s.setNotifPortfolioEodEnabled);
  const setNotifNewsEnabled = useSettingsStore((s) => s.setNotifNewsEnabled);
  const [busy, setBusy] = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  // Once the user has tapped Enable once, show the "I already granted
  // permission" bypass button. We don't show it by default so it doesn't
  // confuse users who would benefit from the OS prompt; but if Enable
  // fails, the bypass is one tap away.
  const [showBypass, setShowBypass] = useState(false);

  const shouldShow = loaded && !introSeen && Capacitor.isNativePlatform();

  // Auto-mark seen on web so users in dev preview don't have a phantom
  // gate. This is benign — there's nothing to schedule on web anyway.
  useEffect(() => {
    if (loaded && !introSeen && !Capacitor.isNativePlatform()) {
      void setIntroSeen(true);
    }
  }, [loaded, introSeen, setIntroSeen]);

  // Auto-skip on mount: if the OS already granted notification permission
  // (e.g. carried over from a prior install / user just granted manually
  // in system settings before re-opening the app), silently flip everything
  // on and mark seen. The user never sees the modal in that case.
  //
  // `hasNotificationPermission` is itself protected by a timeout, so if the
  // plugin bridge is broken this falls through to showing the modal
  // normally rather than hanging the mount.
  useEffect(() => {
    if (!shouldShow) return;
    let cancelled = false;
    (async () => {
      try {
        const granted = await hasNotificationPermission();
        if (cancelled || !granted) return;
        await Promise.all([
          setNotifMasterEnabled(true),
          setNotifTasksEnabled(true),
          setNotifBudgetsEnabled(true),
          setNotifPortfolioEodEnabled(true),
          setNotifNewsEnabled(true),
        ]);
        if (!cancelled) await setIntroSeen(true);
      } catch (e) {
        console.warn('[notif-modal] auto-skip check failed:', (e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    shouldShow,
    setIntroSeen,
    setNotifMasterEnabled,
    setNotifTasksEnabled,
    setNotifBudgetsEnabled,
    setNotifPortfolioEodEnabled,
    setNotifNewsEnabled,
  ]);

  if (!shouldShow) return null;

  // Shared "enable all categories + close" routine. Used by both the
  // permission-grant path and the bypass path so the resulting state is
  // identical regardless of how the user got there.
  const flipEverythingOnAndClose = async () => {
    await Promise.all([
      setNotifMasterEnabled(true),
      setNotifTasksEnabled(true),
      setNotifBudgetsEnabled(true),
      setNotifPortfolioEodEnabled(true),
      setNotifNewsEnabled(true),
    ]);
    await setIntroSeen(true);
  };

  const onEnable = async () => {
    setBusy(true);
    setErrMsg(null);
    // Show bypass IMMEDIATELY so the user has an escape during the
    // permission wait. On a working bridge the wait is <200ms and the
    // bypass is invisible because we close the modal on success. On a
    // wedged bridge the bypass is visible from second 1 and the user
    // can tap it instead of waiting for the timeout.
    setShowBypass(true);
    // Console breadcrumb for adb logcat — if this ever hangs again the
    // logs will at least show how far we got. Capacitor proxies
    // console.log to the native logger:
    //   adb logcat | grep -iE "nexus|chromium|capacitor|notif"
    console.log('[notif-modal] onEnable: requesting permission...');
    try {
      const perm = await ensureNotificationPermission();
      console.log('[notif-modal] onEnable: permission result =', JSON.stringify(perm));
      if (!perm.ok) {
        // Show the error in-modal. Bypass button already visible from above.
        if (perm.reason) console.info('[notif-modal] permission:', perm.reason);
        setErrMsg(t('notifIntro.denied'));
        return;
      }
      await flipEverythingOnAndClose();
    } catch (e) {
      console.warn('[notif-modal] onEnable threw:', (e as Error).message);
      setErrMsg(t('notifIntro.failed'));
    } finally {
      setBusy(false);
    }
  };

  // Bypass: trust that the user has granted the OS perm and just flip
  // everything on without calling the plugin. The downstream schedulers
  // (lib/*Alerts.ts) all do their own permission check before scheduling,
  // so if the user is wrong about the grant, nothing fires — no harm done.
  const onBypass = async () => {
    setBusy(true);
    setErrMsg(null);
    try {
      await flipEverythingOnAndClose();
    } catch (e) {
      console.warn('[notif-modal] enable failed:', (e as Error).message);
      setErrMsg(t('notifIntro.failed'));
    } finally {
      setBusy(false);
    }
  };

  // Not Now is always clickable — never gated by busy. This is the escape
  // hatch from a hanging plugin call. setIntroSeen + close even if some
  // other work is still in flight; the in-flight work runs to completion
  // (or its own timeout) in the background harmlessly.
  const onSkip = async () => {
    try {
      await setIntroSeen(true);
    } catch (e) {
      console.warn('[notif-modal] skip failed:', (e as Error).message);
    }
  };

  return (
    <div className="fixed inset-0 bg-bg/90 z-50 flex items-end sm:items-center justify-center p-4">
      <div className="card-elevated max-w-sm w-full">
        <h2 className="font-heading font-bold text-base mb-1">{t('notifIntro.title')}</h2>
        <p className="text-xs text-text-muted mb-4">{t('notifIntro.body')}</p>
        <ul className="space-y-2 mb-4 text-xs">
          <li className="flex gap-2">
            <span className="text-primary mt-0.5">·</span>
            <span>
              <span className="text-text">{t('settings.taskReminders')}</span>
              <span className="text-text-muted"> — {t('notifIntro.tasksSub')}</span>
            </span>
          </li>
          <li className="flex gap-2">
            <span className="text-primary mt-0.5">·</span>
            <span>
              <span className="text-text">{t('settings.budgetAlerts')}</span>
              <span className="text-text-muted"> — {t('notifIntro.budgetsSub')}</span>
            </span>
          </li>
          <li className="flex gap-2">
            <span className="text-primary mt-0.5">·</span>
            <span>
              <span className="text-text">{t('notifIntro.portfolio')}</span>
              <span className="text-text-muted"> — {t('notifIntro.portfolioSub')}</span>
            </span>
          </li>
          <li className="flex gap-2">
            <span className="text-primary mt-0.5">·</span>
            <span>
              <span className="text-text">{t('settings.marketNews')}</span>
              <span className="text-text-muted"> — {t('notifIntro.newsSub')}</span>
            </span>
          </li>
        </ul>
        <p className="text-[0.625rem] text-text-muted mb-4">
          {t('notifIntro.muteHint')}
        </p>
        {errMsg && (
          <div className="alert alert-warn text-xs mb-3">
            <span className="w-2 h-2 rounded-full bg-warning" />
            <span className="flex-1">{errMsg}</span>
          </div>
        )}
        <div className="space-y-2">
          <button className="btn w-full" onClick={onEnable} disabled={busy}>
            {busy ? t('adoption.working') : t('notifIntro.enable')}
          </button>
          {showBypass && (
            // Bypass intentionally NOT gated by busy — its whole purpose is
            // to be an instant escape from a hanging plugin call. Tapping it
            // while Enable is still waiting on a wedged bridge just makes
            // both racing; whichever finishes first wins, and the bypass
            // path is permission-call-free so it always wins.
            <button
              className="btn-ghost w-full text-primary border-primary/40"
              onClick={onBypass}
            >
              {t('notifIntro.alreadyGranted')}
            </button>
          )}
          {/* Never disabled — primary escape hatch from a hanging plugin
              call. If Enable is stuck "Working…", this still lets the
              user close the modal and use Settings → Notifications
              instead. */}
          <button className="btn-ghost w-full" onClick={onSkip}>
            {t('reportPrompt.notNow')}
          </button>
        </div>
      </div>
    </div>
  );
}
