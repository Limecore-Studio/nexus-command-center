import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSettingsStore } from '../../store/useSettingsStore';
import {
  notificationsAvailable,
  requestNotificationPermission,
  scheduleWeeklyReview,
  cancelWeeklyReview,
} from '../../lib/weeklyNotification';
import { cancelCategory, type NotificationCategory } from '../../lib/notifications';
import { rearmTaskReminders } from '../../lib/taskReminders';
import { runPortfolioEodTick } from '../../lib/portfolioEod';
import { runNewsAlertsTick } from '../../lib/newsAlerts';
import { runWatchlistAlertsTick } from '../../lib/watchlistAlerts';
import { Section, Toggle } from './parts';

// Settings > Notifications: the master switch and the per-category toggles.
// Split out of Settings.tsx with its state (limecore#12).
export default function NotificationsSection() {
  const { t } = useTranslation();
  const weeklyReminder = useSettingsStore((s) => s.weeklyReminder);
  const setWeeklyReminder = useSettingsStore((s) => s.setWeeklyReminder);
  const notifMasterEnabled = useSettingsStore((s) => s.notifMasterEnabled);
  const setNotifMasterEnabled = useSettingsStore((s) => s.setNotifMasterEnabled);
  const notifTasksEnabled = useSettingsStore((s) => s.notifTasksEnabled);
  const setNotifTasksEnabled = useSettingsStore((s) => s.setNotifTasksEnabled);
  const notifBudgetsEnabled = useSettingsStore((s) => s.notifBudgetsEnabled);
  const setNotifBudgetsEnabled = useSettingsStore((s) => s.setNotifBudgetsEnabled);
  const notifPortfolioEodEnabled = useSettingsStore((s) => s.notifPortfolioEodEnabled);
  const setNotifPortfolioEodEnabled = useSettingsStore((s) => s.setNotifPortfolioEodEnabled);
  const notifNewsEnabled = useSettingsStore((s) => s.notifNewsEnabled);
  const setNotifNewsEnabled = useSettingsStore((s) => s.setNotifNewsEnabled);
  const notifWatchlistEnabled = useSettingsStore((s) => s.notifWatchlistEnabled);
  const setNotifWatchlistEnabled = useSettingsStore((s) => s.setNotifWatchlistEnabled);
  const notifMacroKeywordsEnabled = useSettingsStore((s) => s.notifMacroKeywordsEnabled);
  const setNotifMacroKeywordsEnabled = useSettingsStore((s) => s.setNotifMacroKeywordsEnabled);
  const [notifAvailable, setNotifAvailable] = useState(false);
  const [notifMsg, setNotifMsg] = useState<string | null>(null);

  useEffect(() => {
    notificationsAvailable().then(setNotifAvailable);
  }, []);

  return (
    <Section title={t('settings.notifications')}>
      {/* Informational warning when the plugin reports unavailable. Toggles
          below are NOT locked anymore — the previous behavior gated them
          behind `notifAvailable`, but on devices where the Capacitor
          LocalNotifications bridge is wedged, notificationsAvailable()
          returns false and ALL clicks were silently ignored. Now the user
          can always toggle; downstream alert modules check their own
          permission state before scheduling, so a misleading "off" state
          never produces unwanted alerts. */}
      {!notifAvailable && (
        <div className="text-[0.625rem] text-warning px-1 py-1">
          {t('settings.notifPluginUnavail')}
        </div>
      )}
      {/* Master kill-switch. Off = nothing fires regardless of sub-toggle
          state. Flipping ON triggers the OS permission prompt (same flow
          the first-launch modal uses), so this works as the fallback if
          the modal didn't show. Flipping OFF cancels every pending
          notification in every category. Sub-toggles retain their
          individual state so the user can toggle the master back on
          without losing prior preferences. Habit reminders are re-armed
          when it goes back on (rearmHabitsWhenNotificationsOn, v1.18.1). */}
      <Toggle
        label={t('settings.notifMaster')}
        sub={
          notifMasterEnabled
            ? t('settings.notifMasterOnSub')
            : t('settings.notifMasterOffSub')
        }
        value={notifMasterEnabled}
        onChange={async (on) => {
          setNotifMsg(null);
          if (on) {
            // OPTIMISTIC FLIP — same rationale as handleNotifToggle:
            // flip first so the UI is responsive, request perm in the
            // background, never block. If the plugin bridge hangs we
            // still have a working toggle; downstream scheduling will
            // succeed once perm is actually granted at the OS level
            // (and silently no-op until then).
            await setNotifMasterEnabled(true);
            // Default the 4 main categories ON the FIRST time master
            // is enabled (matches the explainer modal's behavior). If
            // the user has flipped these before, leave their picks alone.
            const anySubOn =
              notifTasksEnabled || notifBudgetsEnabled ||
              notifPortfolioEodEnabled || notifNewsEnabled || notifWatchlistEnabled || weeklyReminder;
            if (!anySubOn) {
              await Promise.all([
                setNotifTasksEnabled(true),
                setNotifBudgetsEnabled(true),
                setNotifPortfolioEodEnabled(true),
                setNotifNewsEnabled(true),
                setNotifWatchlistEnabled(true),
              ]);
              void rearmTaskReminders();
              void runPortfolioEodTick();
              void runNewsAlertsTick();
              void runWatchlistAlertsTick();
            }
            // Background perm check. If it fails (most likely the
            // plugin bridge is wedged), warn the user but leave the
            // toggle on — they may have already granted at the OS
            // level, in which case downstream scheduling works fine
            // even though our perm-check call hangs/fails.
            void (async () => {
              try {
                const perm = await requestNotificationPermission();
                if (!perm.ok) {
                  setNotifMsg(
                    (perm.reason ?? t('settings.permCheckFailed')) +
                      t('settings.permMasterTail'),
                  );
                }
              } catch (e) {
                setNotifMsg((e as Error).message);
              }
            })();
          } else {
            await setNotifMasterEnabled(false);
            // Wipe every pending alarm in every category so nothing
            // fires after the user has explicitly turned the master
            // switch off. Sub-toggles keep their bool state.
            await Promise.all([
              cancelCategory('weekly-review'),
              cancelCategory('tasks'),
              cancelCategory('budgets'),
              cancelCategory('portfolio-eod'),
              cancelCategory('news'),
              cancelCategory('watchlist'),
              // v1.18.1 (NCC#151): these two were missed.
              cancelCategory('habits'),
              cancelCategory('insights'),
            ]);
          }
        }}
      />
      <Toggle
        label={t('settings.weeklyReviewLabel')}
        sub={t('settings.weeklyReviewSub')}
        value={weeklyReminder}
        locked={!notifMasterEnabled}
        onChange={async (on) => {
          setNotifMsg(null);
          if (on) {
            // Optimistic — flip the toggle, then schedule + check perm
            // in the background. Same rationale as the master toggle:
            // if the plugin bridge hangs, the UI shouldn't.
            await setWeeklyReminder(true);
            void (async () => {
              try {
                const perm = await requestNotificationPermission();
                if (!perm.ok) {
                  setNotifMsg(
                    (perm.reason ?? t('settings.permCheckFailed')) +
                      t('settings.permWeeklyTail'),
                  );
                  return;
                }
                const sched = await scheduleWeeklyReview();
                if (!sched.ok) {
                  setNotifMsg(sched.reason ?? t('settings.failedSchedule'));
                }
              } catch (e) {
                setNotifMsg((e as Error).message);
              }
            })();
          } else {
            await setWeeklyReminder(false);
            await cancelWeeklyReview();
          }
        }}
      />
      <Toggle
        label={t('settings.taskReminders')}
        sub={t('settings.taskRemindersSub')}
        value={notifTasksEnabled}
        locked={!notifMasterEnabled}
        onChange={(on) => handleNotifToggle({
          on,
          category: 'tasks',
          setEnabled: setNotifTasksEnabled,
          requestPerm: requestNotificationPermission,
          setMsg: setNotifMsg,
          t,
          // On flip-on, schedule alarms for every existing incomplete
          // task — otherwise the user has to add a new task before any
          // notifications show up.
          onAfterEnable: rearmTaskReminders,
        })}
      />
      <Toggle
        label={t('settings.budgetAlerts')}
        sub={t('settings.budgetAlertsSub')}
        value={notifBudgetsEnabled}
        locked={!notifMasterEnabled}
        onChange={(on) => handleNotifToggle({
          on,
          category: 'budgets',
          setEnabled: setNotifBudgetsEnabled,
          requestPerm: requestNotificationPermission,
          setMsg: setNotifMsg,
          t,
        })}
      />
      <Toggle
        label={t('settings.portfolioEod')}
        sub={t('settings.portfolioEodSub')}
        value={notifPortfolioEodEnabled}
        locked={!notifMasterEnabled}
        onChange={(on) => handleNotifToggle({
          on,
          category: 'portfolio-eod',
          setEnabled: setNotifPortfolioEodEnabled,
          requestPerm: requestNotificationPermission,
          setMsg: setNotifMsg,
          t,
          // Prime today's 4:05pm + 4:35pm alarms immediately on flip-on
          // (if today is a trading day, etc.). Otherwise the user
          // wouldn't get any notification until the next portfolio
          // refresh or app cold-start.
          onAfterEnable: runPortfolioEodTick,
        })}
      />
      <Toggle
        label={t('settings.marketNews')}
        sub={t('settings.marketNewsSub')}
        value={notifNewsEnabled}
        locked={!notifMasterEnabled}
        onChange={(on) => handleNotifToggle({
          on,
          category: 'news',
          setEnabled: setNotifNewsEnabled,
          requestPerm: requestNotificationPermission,
          setMsg: setNotifMsg,
          t,
          // Scan whatever news is already in store. If the portfolio
          // hasn't refreshed yet this is a no-op; the next refresh
          // will populate news and fire then.
          onAfterEnable: runNewsAlertsTick,
        })}
      />
      {/* Macro-headline classifier is noisier (Fed/CPI/jobs keywords on
          general headlines), so it's off by default and gated under News.
          When News is off this toggle does nothing — we lock it visually
          to make that clear. */}
      <Toggle
        label={t('settings.macroHeadlines')}
        sub={t('settings.macroHeadlinesSub')}
        value={notifMacroKeywordsEnabled}
        locked={!notifMasterEnabled || !notifNewsEnabled}
        onChange={setNotifMacroKeywordsEnabled}
      />
      {/* v1.15 Item 9 — targets have always been settable on the Watchlist;
          this is what makes one worth setting. Below the news pair rather
          than inside it: a target is the user's own number, not a story. */}
      <Toggle
        label={t('settings.watchlistAlerts')}
        sub={t('settings.watchlistAlertsSub')}
        value={notifWatchlistEnabled}
        locked={!notifMasterEnabled}
        onChange={(on) => handleNotifToggle({
          on,
          category: 'watchlist',
          setEnabled: setNotifWatchlistEnabled,
          requestPerm: requestNotificationPermission,
          setMsg: setNotifMsg,
          t,
          onAfterEnable: runWatchlistAlertsTick,
        })}
      />
      {notifMsg && (
        <div className="text-[0.625rem] text-warning mt-1">{notifMsg}</div>
      )}
    </Section>
  );
}

// Shared turn-on/turn-off flow for every per-category notification toggle.
//
// Turn ON:
//   1. Request OS permission (no-op if already granted)
//   2. If denied, surface the reason via setMsg and bail — toggle stays off
//   3. Save the enabled flag
//   4. Optional `onAfterEnable` hook — used by categories that maintain
//      per-row schedules (Task Reminders re-arms every existing task,
//      Portfolio EoD primes its 4:05pm + 4:35pm alarms, etc.). Without this
//      hook the user would have to add a new task / wait for the next
//      portfolio refresh before any notifications actually appeared.
//
// Turn OFF:
//   1. Save the disabled flag immediately so any racing scheduler bails
//   2. Cancel every pending notification in the category — without this,
//      already-scheduled alarms would still fire after the user turned the
//      category off
// Optimistic toggle flow. The OLD version awaited requestPerm() before
// flipping the toggle — fine when the plugin works, but a hard hang for
// users where the Capacitor LocalNotifications bridge gets wedged
// (checkPermissions/requestPermissions never resolve, even with OS perm
// granted). Symptom: the toggle visually doesn't move because the await
// in onChange never returns.
//
// New flow:
//   1. Flip the toggle state immediately so the UI is responsive.
//   2. Kick the perm request in the background (don't await).
//   3. If perm comes back NOT ok, show a warning — but leave the toggle ON.
//      The downstream schedulers (budgetAlerts, taskReminders, etc.) all
//      do their own permission check before scheduling, so if perm really
//      is denied nothing fires. The toggle being "on" is just the user's
//      stated intent; whether notifs actually appear depends on OS perm.
//   4. If perm comes back ok, no message — silent success.
//
// Turn-off path stays synchronous because cancelling is fast and the user
// expects "off" to mean "stop scheduling" immediately.
async function handleNotifToggle(opts: {
  on: boolean;
  category: NotificationCategory;
  setEnabled: (on: boolean) => Promise<void>;
  requestPerm: () => Promise<{ ok: boolean; reason?: string }>;
  setMsg: (msg: string | null) => void;
  t: (key: string) => string;
  onAfterEnable?: () => Promise<void> | void;
}): Promise<void> {
  const { on, category, setEnabled, requestPerm, setMsg, t, onAfterEnable } = opts;
  setMsg(null);
  if (on) {
    // Step 1 — flip immediately. UI is responsive even if perm hangs.
    await setEnabled(true);
    // Step 2 — kick perm request in background. NOT awaited.
    void (async () => {
      try {
        const perm = await requestPerm();
        if (!perm.ok) {
          setMsg(
            (perm.reason ?? t('settings.permCheckFailed')) +
              t('settings.permToggleTail'),
          );
        }
      } catch (e) {
        setMsg((e as Error).message);
      }
    })();
    // Step 3 — run the per-category re-arm hook (also non-blocking from
    // the toggle's perspective; schedulers handle their own errors).
    if (onAfterEnable) {
      void (async () => {
        try {
          await onAfterEnable();
        } catch (e) {
          setMsg((e as Error).message);
        }
      })();
    }
  } else {
    await setEnabled(false);
    await cancelCategory(category);
  }
}
