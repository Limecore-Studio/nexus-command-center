import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { App as CapacitorApp } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import { Capacitor } from '@capacitor/core';
import { useAuthStore } from './store/useAuthStore';
import { APP_LOCK_APPLIES } from './lib/isDesktop';
import { useSessionStore } from './store/useSessionStore';
import { useSyncStore } from './store/useSyncStore';
import { seedIfEmpty } from './db/seed';
import { clearAllLocalData } from './db/database';
import { supabase } from './lib/supabase';
import { useTranslation } from 'react-i18next';
import { startRealtime, stopRealtime } from './lib/realtime';
import { hydrateStudiesFromCloud, hydrateHabitsFromCloud, hydrateBodyMetricsFromCloud, hydrateWorkQualityFromCloud, hydrateBraindumpFromCloud } from './lib/cloudSync';
import { watchAppOpens } from './lib/appOpens';
import { refreshEntitlement } from './lib/entitlement';
import { useStudiesStore } from './store/useStudiesStore';
import { useBraindumpStore } from './store/useBraindumpStore';
import { isGuestMode } from './lib/guestMode';
import AdoptionPrompt from './components/AdoptionPrompt';
import ReferralPrompt from './components/ReferralPrompt';
import NotificationsExplainerModal from './components/NotificationsExplainerModal';
import LockScreen from './screens/LockScreen';
import Login from './screens/auth/Login';
import AppShell from './components/AppShell';
import Dashboard from './screens/Dashboard';
import { onNotificationTap, scheduleWeeklyReview } from './lib/weeklyNotification';
import { onNotificationAction } from './lib/notifications';
import { installRatingHistory } from './lib/ratingHistory';
import { useTaskStore } from './store/useTaskStore';
import { useSettingsStore } from './store/useSettingsStore';
import { useHabitsStore, rearmHabitsWhenNotificationsOn } from './store/useHabitsStore';
import { useBodyMetricsStore } from './store/useBodyMetricsStore';
import { useWorkQualityStore } from './store/useWorkQualityStore';
import { useLifeProfileStore } from './store/useLifeProfileStore';
import { useFinanceStore } from './store/useFinanceStore';
import { isOnboarded, setOnboarded, hydrateOnboardedFromCloud, markOnboardedCloud } from './lib/onboarding';
import { desktop } from './lib/desktop';
import { checkForDesktopUpdate } from './lib/desktopUpdate';

// v1.17 (limecore#13): every screen a launch cannot open on is its own chunk,
// loaded the first time it is visited. Login, the lock screen and the
// Dashboard stay in the entry chunk because one of them is always the first
// thing a launch shows.
const Signup = lazy(() => import('./screens/auth/Signup'));
const Onboarding = lazy(() => import('./screens/Onboarding'));
const FinanceOverview = lazy(() => import('./screens/finance/FinanceOverview'));
const AddTransaction = lazy(() => import('./screens/finance/AddTransaction'));
const Portfolio = lazy(() => import('./screens/finance/Portfolio'));
const ManageBudgets = lazy(() => import('./screens/finance/ManageBudgets'));
const ImportTransactions = lazy(() => import('./screens/finance/ImportTransactions'));
const ManageHoldings = lazy(() => import('./screens/finance/ManageHoldings'));
const ManageLots = lazy(() => import('./screens/finance/ManageLots'));
const NetWorth = lazy(() => import('./screens/finance/NetWorth'));
const AccountDetail = lazy(() => import('./screens/finance/AccountDetail'));
const WhatIf = lazy(() => import('./screens/finance/WhatIf'));
const Watchlist = lazy(() => import('./screens/finance/Watchlist'));
const Insights = lazy(() => import('./screens/finance/Insights'));
const SavingsGoals = lazy(() => import('./screens/finance/SavingsGoals'));
const TasksOverview = lazy(() => import('./screens/tasks/TasksOverview'));
const AddTask = lazy(() => import('./screens/tasks/AddTask'));
const HabitsOverview = lazy(() => import('./screens/habits/HabitsOverview'));
const AddHabit = lazy(() => import('./screens/habits/AddHabit'));
const Braindump = lazy(() => import('./screens/Braindump'));
const Life = lazy(() => import('./screens/Life'));
const WeeklyReview = lazy(() => import('./screens/WeeklyReview'));
const YearReview = lazy(() => import('./screens/YearReview'));
const Goals = lazy(() => import('./screens/Goals'));
const Settings = lazy(() => import('./screens/Settings'));
const LifeProfileSettings = lazy(() => import('./screens/LifeProfileSettings'));

export default function App() {
  const unlocked = useAuthStore((s) => s.unlocked);
  const initAuth = useAuthStore((s) => s.init);
  const initSync = useSyncStore((s) => s.init);
  const session = useSessionStore((s) => s.session);
  const sessionLoading = useSessionStore((s) => s.loading);
  const initSession = useSessionStore((s) => s.init);
  const syncNow = useSyncStore((s) => s.syncNow);
  const { t } = useTranslation();

  // Guest-mode flag — when true, App.tsx skips the auth gate even with no
  // Supabase session. Loaded once on mount, then re-evaluated whenever the
  // Login screen dispatches `nexus:guest-mode-changed` (after tap on
  // "Continue as guest"). Settings clears the flag when the user signs in.
  // `null` while the initial read is in flight — render the splash same as
  // the session-loading branch so we don't flash the Login screen for
  // returning guest-mode users.
  const [guestMode, setGuestModeState] = useState<boolean | null>(null);
  // v1.6 — first-run onboarding gate. `onboarded` flips when the wizard
  // finishes/skips; seeded from the local flag (or a pre-1.6 saved profile).
  const [onboarded, setOnboardedState] = useState<boolean>(() => isOnboarded());
  const [onboardChecked, setOnboardChecked] = useState(false);

  // v1.10 - ask the ACCOUNT whether onboarding is already done, not just this
  // device. Gated behind `onboardChecked` so a signed-in user never sees a
  // frame of the wizard before the answer arrives; a guest resolves instantly
  // because there is no account to ask.
  useEffect(() => {
    // HYG-4: The synchronous set is the point: a guest has no account to ask, so the
    // gate has to resolve in this same commit or the wizard shows a frame
    // before the answer arrives — the exact bug the v1.10 note above fixed.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!session) { setOnboardChecked(true); return; }
    let cancelled = false;
    setOnboardChecked(false);
    void hydrateOnboardedFromCloud().then((done) => {
      if (cancelled) return;
      if (done) setOnboardedState(true);
      setOnboardChecked(true);
    });
    return () => { cancelled = true; };
  }, [session]);
  const lifeProfileLoaded = useLifeProfileStore((s) => s.loaded);

  useEffect(() => {
    (async () => {
      // Init session first — we need to know auth state before anything else.
      await initSession();

      // Read guest flag in parallel with session restore. Both inform the
      // gate logic below; we resolve to a final state once both are known.
      const guest = await isGuestMode();
      setGuestModeState(guest);

      // One-time wipe of prior seeded sample data.
      if (localStorage.getItem('nexus.seeded.v1') && !localStorage.getItem('nexus.wiped.v1')) {
        await clearAllLocalData();
        localStorage.removeItem('nexus.seeded.v1');
        localStorage.setItem('nexus.wiped.v1', '1');
      }
      await seedIfEmpty();
      // v1.12 Item 10 - Braindump entries live in Dexie and are local, so this
      // load belongs in the mount bootstrap rather than in the session-gated
      // hydration block below. A guest captures ideas too, and without this
      // their dashboard card would read empty while their entries sat on disk.
      await useBraindumpStore.getState().load();
      await initAuth();
      initSync();
      // v1.2 — install the Insights rating-history observer. Runs once;
      // subsequent installs replace the same singleton observer. Must be
      // installed BEFORE any recomputeAll call so the very first batch
      // populates the history table + fires tier-change pushes correctly.
      installRatingHistory();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberate mount-only bootstrap sequence; store actions are stable Zustand references, re-running this on their identity would re-fire the whole app-init chain
  }, []);

  // Listen for guest-mode toggle events fired by Login.tsx and Settings.tsx.
  // The Preferences plugin doesn't emit changes natively, so we use a
  // CustomEvent contract on `window` to keep the gate reactive.
  useEffect(() => {
    const onGuestChange = () => {
      void (async () => {
        const guest = await isGuestMode();
        setGuestModeState(guest);
      })();
    };
    window.addEventListener('nexus:guest-mode-changed', onGuestChange);
    return () => window.removeEventListener('nexus:guest-mode-changed', onGuestChange);
  }, []);

  // Auto-sync when a session becomes available (sign-in or app reopen with
  // valid session). Adoption prompt — if shown — runs its own sync after the
  // user makes a choice, so this won't double-fire problematically.
  //
  // Critical ordering for StudyDesk hydration:
  //   1. Run an explicit fetch on subjects/grades/study_sessions (StudyDesk
  //      owns these tables in the shared Supabase project) and write the
  //      results to Dexie. Realtime ONLY delivers deltas from the moment you
  //      subscribe — any pre-existing rows would otherwise be invisible to
  //      NCC until the user edited them in StudyDesk.
  //   2. Reload the studies store so the UI reflects the hydrated rows.
  //   3. THEN open the Realtime subscription so future deltas merge cleanly.
  //   4. Kick the full background syncNow() afterward for the other tables
  //      (transactions, portfolio, etc.) — non-blocking.
  // v1.12 Item 0 — retention. Session-gated rather than mount-only: an open
  // recorded before the session is restored has no user to attribute it to and
  // would be skipped. The visibilitychange listener installed here covers the
  // commoner case — the app resumed from the background days later without the
  // process having died.
  useEffect(() => {
    if (!session) return;
    return watchAppOpens();
  }, [session]);

  // v1.12 Item 5 — supporter entitlement. Keyed on the user id rather than the
  // session object so a token refresh does not re-ask; the module additionally
  // serves from cache for six hours, so this is close to free on an ordinary
  // launch. A network failure keeps the cached answer rather than stripping a
  // supporter's perk.
  useEffect(() => {
    const uid = session?.user?.id;
    if (!uid) return;
    void refreshEntitlement(uid);
  }, [session?.user?.id]);

  useEffect(() => {
    if (!session) {
      stopRealtime();
      return;
    }
    const userId = session.user.id;
    (async () => {
      try {
        const result = await hydrateStudiesFromCloud(userId);
        console.log(
          `[app-init] studies hydrated: subjects=${result.subjects}, grades=${result.grades}, study_sessions=${result.studySessions}, errors=${result.errors.length}`,
        );
        if (result.errors.length > 0) {
          console.warn('[app-init] hydration errors:', result.errors);
        }
        // Refresh the studies store from Dexie so the just-written rows
        // surface immediately. Other stores get refreshed by syncNow() below.
        await useStudiesStore.getState().load();
      } catch (e) {
        console.warn('[app-init] studies hydration threw:', e);
      }
      // v1.2 — habits hydration runs as a sibling of studies. Same shape:
      // pull all rows for the user into Dexie, refresh the store, then let
      // the realtime channel handle subsequent deltas. Fire-and-forget; a
      // failure here doesn't block the rest of app-init.
      try {
        const habitsResult = await hydrateHabitsFromCloud(userId);
        console.log(
          `[app-init] habits hydrated: habits=${habitsResult.habits}, completions=${habitsResult.completions}, errors=${habitsResult.errors.length}`,
        );
        if (habitsResult.errors.length > 0) {
          console.warn('[app-init] habits hydration errors:', habitsResult.errors);
        }
        await useHabitsStore.getState().load();
      } catch (e) {
        console.warn('[app-init] habits hydration threw:', e);
      }
      // v1.3 — body metrics hydration. Read-only consumption of LimeLog's
      // body_metrics table. The dedicated Fitness screen was removed in the
      // v1.3 scope reduction (BUG-15); this stays as the Dexie landing zone
      // for the body_metrics realtime subscription + a future life-signal
      // input, so the table + store are kept warm even without a UI surface.
      // Same sibling-of-habits shape; fire-and-forget so a failure doesn't
      // block app-init.
      try {
        const bodyResult = await hydrateBodyMetricsFromCloud(userId);
        console.log(
          `[app-init] body metrics hydrated: rows=${bodyResult.bodyMetrics}, errors=${bodyResult.errors.length}`,
        );
        if (bodyResult.errors.length > 0) {
          console.warn('[app-init] body metrics hydration errors:', bodyResult.errors);
        }
        await useBodyMetricsStore.getState().load();
      } catch (e) {
        console.warn('[app-init] body metrics hydration threw:', e);
      }
      // v1.5 — Work domain self-assessment hydration. NCC-native; pull the
      // user's logs from the cloud so the Home WorkRatingCard + Life Work
      // score reflect ratings made on another device. Sibling-of-habits
      // shape; fire-and-forget so a failure doesn't block app-init.
      try {
        const workResult = await hydrateWorkQualityFromCloud(userId);
        console.log(
          `[app-init] work quality hydrated: rows=${workResult.workQualityLogs}, errors=${workResult.errors.length}`,
        );
        if (workResult.errors.length > 0) {
          console.warn('[app-init] work quality hydration errors:', workResult.errors);
        }
        await useWorkQualityStore.getState().load();
      } catch (e) {
        console.warn('[app-init] work quality hydration threw:', e);
      }
      // v1.12 Item 10 - Braindump hydration. Same fire-and-forget shape as the
      // siblings above: an idea captured on the phone should be on the desktop
      // without waiting for a manual sync, and a failure here must not block
      // app-init.
      try {
        const bdResult = await hydrateBraindumpFromCloud(userId);
        console.log(
          `[app-init] braindump hydrated: rows=${bdResult.braindumpEntries}, errors=${bdResult.errors.length}`,
        );
        if (bdResult.errors.length > 0) {
          console.warn('[app-init] braindump hydration errors:', bdResult.errors);
        }
        await useBraindumpStore.getState().load();
      } catch (e) {
        console.warn('[app-init] braindump hydration threw:', e);
      }
      // v1.6 — Finance store load. Finance (transactions + budget categories)
      // is NCC-native and pulled by fullSync below, but the in-memory finance
      // store starts empty and is only refreshed by reloadDataStores() inside
      // syncNow — which is gated on a clean pull. On a cold start the Life tab
      // computes its report (incl. the Finance domain's "ever used" flag from
      // budgets) before that lands, so Finance reads "Not counted yet" despite
      // budgets existing. Loading from Dexie here — the local source of truth,
      // persisted across launches — makes the Finance domain count immediately
      // for any user who has ever synced budgets to this device. Cheap (no
      // network); fire-and-forget so a failure doesn't block app-init.
      try {
        await useFinanceStore.getState().load();
      } catch (e) {
        console.warn('[app-init] finance load threw:', e);
      }
      // v1.5 — Life Profile. Reads the local cache instantly at store
      // creation; load() pulls the cross-device value from
      // user_preferences.life_profile now that we have a session.
      try {
        await useLifeProfileStore.getState().load();
      } catch (e) {
        console.warn('[app-init] life profile load threw:', e);
      }
      // Now open the realtime channel for future deltas.
      // v1.2.1 — AUDIT-FSG-5: pass userId so per-table subscriptions can
      // scope to `user_id=eq.<uid>` on tables without a sharing surface.
      startRealtime(userId);
      // Fire-and-forget the full sync for everything else (push pending
      // queue + pull transactions/portfolio/tasks/etc.).
      void syncNow();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberately narrowed to the user id: the `session` object is recreated on every token refresh, and re-running this hydration+sync chain on that churn (rather than on an actual user change) is the bug this narrowing prevents. syncNow is a stable Zustand action.
  }, [session?.user?.id]);

  // OAuth deep-link handler: when Supabase redirects back via
  // com.limecore.nexus://login-callback?code=... after Google sign-in,
  // exchange the code for a session.
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    const sub = CapacitorApp.addListener('appUrlOpen', async (event) => {
      try {
        const url = event.url;
        if (!url.startsWith('com.limecore.nexus://login-callback')) return;
        // Extract the auth code from the URL.
        const qs = url.split('?')[1] ?? '';
        const params = new URLSearchParams(qs);
        const code = params.get('code');
        if (code) {
          await supabase.auth.exchangeCodeForSession(code);
        }
      } finally {
        // Close the in-app browser (Chrome Custom Tab) once we're back.
        try {
          await Browser.close();
        } catch {
          /* not always open */
        }
      }
    });
    return () => {
      sub.then((s) => s.remove());
    };
  }, []);

  // v1.12.1 — the desktop equivalent of the deep-link handler above. The
  // Electron shell receives Supabase's redirect on a loopback listener and
  // hands the code over IPC; the exchange has to happen HERE because the PKCE
  // code verifier lives in this renderer's storage and nowhere else. Before
  // this, `OAUTH_REDIRECT_URL` was `nexus://app/` — un-allowlistable — so
  // Supabase bounced to the Site URL and took the app's own window with it.
  useEffect(() => {
    if (!desktop?.onCallback) return;
    return desktop.onCallback(({ code }) => {
      if (!code) return;
      void supabase.auth.exchangeCodeForSession(code);
    });
  }, []);

  // v1.15 (Item 12) — one release check per launch; a no-op off desktop.
  useEffect(() => {
    checkForDesktopUpdate();
  }, []);

  // 1. Wait for session restoration AND guest flag read before deciding.
  // guestMode === null means the Preferences read hasn't resolved yet —
  // render the splash same as session-loading to avoid flashing the Login
  // screen for returning guest-mode users on cold start.
  if (sessionLoading || guestMode === null) {
    return (
      <div className="min-h-full bg-bg text-text flex items-center justify-center">
        <div className="text-text-muted text-xs uppercase tracking-wider">{t('common.loading')}</div>
      </div>
    );
  }

  // 2. No Supabase session AND not in guest mode → show auth screens.
  // Guest-mode users skip this gate and land directly in the app; their
  // Supabase-backed features (sync, SSO publishing, adoption prompt cloud
  // flag) all no-op gracefully when `session` is null.
  if (!session && !guestMode) {
    return (
      // Signup is a lazy chunk (limecore#13); it loads from local assets in a
      // frame or two, so nothing is shown meanwhile.
      <Suspense fallback={null}>
        <Routes>
          <Route path="/auth/login" element={<Login />} />
          <Route path="/auth/signup" element={<Signup />} />
          <Route path="*" element={<Navigate to="/auth/login" replace />} />
        </Routes>
      </Suspense>
    );
  }

  // 3. Session OK (or guest mode active) but device not unlocked → LockScreen.
  // PIN/biometric still gates a guest-mode session if the user has set one,
  // so the lock UX stays consistent regardless of cloud auth state.
  //
  // NOT ON DESKTOP. The app lock is a phone control: it answers "someone else
  // picked up my unlocked handset", and it pays for that with a PIN pad on
  // every cold start. A desktop machine already sits behind an OS session the
  // user logs into, so the second gate buys nothing and charges the same
  // price — and it charges it worse here, because the desktop window has no
  // biometric to fall back on, making the PIN the only way in and a forgotten
  // one a locked-out install. Removed for that build, not weakened for any
  // other.
  //
  // NOT ON WEB EITHER (2026-09-18, owner call): the same reasoning applies to
  // a browser tab. Android is the only build that keeps the lock.
  if (!unlocked && APP_LOCK_APPLIES) {
    return <LockScreen />;
  }

  // 3.5 First-run onboarding. Show the wizard once on a fresh setup — no
  // Life Profile configured and the onboarding flag unset. For a signed-in
  // user we wait for the cloud life_profile load to resolve (so a returning
  // user whose profile lives only in the cloud isn't flashed the wizard);
  // guests have no cloud load, so the local check stands alone. Re-checking
  // isOnboarded() here catches the case where the cloud load just wrote a
  // profile into local storage.
  if (!onboarded && (!session || (lifeProfileLoaded && onboardChecked)) && !isOnboarded()) {
    return (
      <Suspense fallback={null}>
        <Onboarding
          onDone={() => {
            setOnboarded();
            void markOnboardedCloud();
            setOnboardedState(true);
          }}
        />
      </Suspense>
    );
  }

  // 4. Fully authenticated. Render the app.
  return (
    <>
      <AdoptionPrompt />
      {/* Item 8 — asks once per account, inside the account-age window only.
          Non-blocking by design; see the component. */}
      <ReferralPrompt />
      {/* First-launch (post-upgrade) explainer for notifications. Renders
          nothing once the user has dismissed it once via either path
          ("Enable Notifications" or "Not Now"). Native-only — see the
          component for the rationale. */}
      <NotificationsExplainerModal />
      <NotificationBridge />
      <Routes>
        <Route element={<AppShell />}>
          <Route path="/" element={<Dashboard />} />
          <Route path="/finance" element={<FinanceOverview />} />
          <Route path="/finance/add" element={<AddTransaction />} />
          <Route path="/finance/portfolio" element={<Portfolio />} />
          <Route path="/finance/portfolio/manage" element={<ManageHoldings />} />
          <Route path="/finance/portfolio/lots/:id" element={<ManageLots />} />
          <Route path="/finance/portfolio/watchlist" element={<Watchlist />} />
          <Route path="/finance/insights" element={<Insights />} />
          <Route path="/finance/savings" element={<SavingsGoals />} />
          <Route path="/finance/networth" element={<NetWorth />} />
          {/* v1.2 follow-up — CTO Account refactor. Per-account statement
              view: derived running balance + transaction history. */}
          <Route path="/finance/account/:id" element={<AccountDetail />} />
          <Route path="/finance/whatif" element={<WhatIf />} />
          <Route path="/finance/budgets" element={<ManageBudgets />} />
          {/* v1.9 Item 14b #4 — CSV import/export. */}
          <Route path="/finance/import" element={<ImportTransactions />} />
          <Route path="/tasks" element={<TasksOverview />} />
          {/* v1.12 Item 10 - Braindump quick capture. */}
          <Route path="/braindump" element={<Braindump />} />
          <Route path="/tasks/add" element={<AddTask />} />
          <Route path="/habits" element={<HabitsOverview />} />
          <Route path="/habits/add" element={<AddHabit />} />
          <Route path="/life" element={<Life />} />
          <Route path="/review" element={<WeeklyReview />} />
          <Route path="/review/year" element={<YearReview />} />
          <Route path="/goals" element={<Goals />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/settings/life-profile" element={<LifeProfileSettings />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </>
  );
}

/**
 * Mounts inside the Router so it can `useNavigate()` to route on notification
 * taps. Also re-schedules the Sunday Weekly Review push on every app start
 * if the user has the toggle enabled — Android may drop alarms after reboot
 * or doze, so re-issuing the schedule each session is cheap insurance.
 */
function NotificationBridge() {
  const navigate = useNavigate();
  const weeklyReminder = useSettingsStore((s) => s.weeklyReminder);
  const settingsLoaded = useSettingsStore((s) => s.loaded);
  const loadSettings = useSettingsStore((s) => s.load);

  // Settings need to be loaded before we can decide whether to schedule.
  useEffect(() => {
    if (!settingsLoaded) void loadSettings();
  }, [settingsLoaded, loadSettings]);

  useEffect(() => {
    if (!settingsLoaded) return;
    if (weeklyReminder) {
      void scheduleWeeklyReview();
    }
  }, [settingsLoaded, weeklyReminder]);

  // v1.18.1 (NCC#151): re-arm habit reminders once settings and habits are
  // loaded with notifications on, and each time the master switch turns back
  // on. A store subscription with its own edge check, so it acts on those
  // transitions only, not on renders.
  useEffect(() => rearmHabitsWhenNotificationsOn(), []);

  // v1.18.1 (NCC#143): subscribed ONCE. `navigate` changes identity with
  // the route (React Router 7, HashRouter), and every re-subscription drained
  // the native buffer again, replaying an old tap or "Mark done". The
  // handlers read the current navigate through a ref instead.
  const navigateRef = useRef(navigate);
  useEffect(() => {
    navigateRef.current = navigate;
  }, [navigate]);

  useEffect(() => {
    let unsub: () => void = () => {};
    let cancelled = false;
    onNotificationTap((route) => navigateRef.current(route)).then((u) => {
      if (cancelled) u();
      else unsub = u;
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, []);

  // Action-button taps. Each action ID maps to a different side-effect:
  //   'done'  → mark a task complete (extra.taskId)
  //   'view'  → open a target route (e.g. /finance/budgets with cat id)
  //   future actions add a case here. Unknown IDs are silently dropped.
  // The notification is auto-dismissed by NotificationActionReceiver
  // before this fires, so no manual cancel is needed.
  useEffect(() => {
    let unsub: () => void = () => {};
    let cancelled = false;
    onNotificationAction((payload) => {
      const { actionId, route, extra } = payload;
      if (actionId === 'done' && extra && typeof extra.taskId === 'string') {
        // Fire-and-forget — setComplete handles its own persistence.
        // v1.18.1 (NCC#143): set, not toggle. The same "Mark done" can arrive
        // twice (live, then from the native buffer), and a toggle undid it.
        void useTaskStore.getState().setComplete(extra.taskId, true);
        return;
      }
      if (actionId === 'view' && route) {
        navigateRef.current(route);
        return;
      }
      // Unknown actionId — log so we notice if a new scheduler ships an
      // action ID without a corresponding handler.
      console.warn('[notifications] unhandled action', actionId);
    }).then((u) => {
      if (cancelled) u();
      else unsub = u;
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, []);

  return null;
}
