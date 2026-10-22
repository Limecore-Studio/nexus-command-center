import { create, type StoreApi } from 'zustand';
import { listOwnPending } from '../db/syncQueue';
import { fullSync, PushResult, PullResult } from '../lib/cloudSync';
import { coalesce } from '../lib/coalesce';
import { reconcileTaskRemindersIfChanged } from '../lib/taskReminders';
import { useSessionStore } from './useSessionStore';
import { adoptionClearFor } from '../lib/adoptionGate';
import { useFinanceStore } from './useFinanceStore';
import { useStudiesStore } from './useStudiesStore';
import { useFitnessStore } from './useFitnessStore';
import { useTaskStore } from './useTaskStore';
import { useGoalsStore } from './useGoalsStore';
import { useBodyMetricsStore } from './useBodyMetricsStore';
import { useWorkQualityStore } from './useWorkQualityStore';
import { useBraindumpStore } from './useBraindumpStore';
import { useHabitsStore } from './useHabitsStore';

// Reload every cloud-synced data store from Dexie. Called after each pull so
// that rows newly merged into Dexie (from other devices, Realtime triggers,
// or external apps like the workout tracker / StudyDesk pushing into the
// shared Supabase project) actually surface in the UI without requiring a
// manual navigation or app restart.
//
// Each store's `load()` re-reads its tables and replaces its in-memory state.
// They run in parallel because none depend on each other for read-time data.
async function reloadDataStores(): Promise<void> {
  try {
    await Promise.all([
      useFinanceStore.getState().load(),
      useStudiesStore.getState().load(),
      useFitnessStore.getState().load(),
      useTaskStore.getState().load(),
      useGoalsStore.getState().load(),
      // v1.3 — body metrics surface on the Fitness screen; refresh after a
      // realtime-triggered pull so a cross-device LimeLog body-metric edit
      // shows up without a navigation. (AUDIT-FSG-5b: this is the in-memory
      // half of the fix — the Dexie half is hydrateBodyMetricsFromCloud in
      // pullAll.)
      useBodyMetricsStore.getState().load(),
      // v1.5 — Work domain self-assessment. Refresh after a pull so a rating
      // made on another device shows on the Home card + Life Work score.
      useWorkQualityStore.getState().load(),
      // v1.12 Item 10 - Braindump. Refresh after a pull so an idea captured on
      // another device appears without a navigation, same as the two above.
      useBraindumpStore.getState().load(),
      // v1.18.1 (NCC#138): habits. pullAll has re-hydrated them into Dexie on
      // every sync since v1.3, but the store was only reloaded at launch, so a
      // habit archived or cleared of its reminder on another device kept its
      // daily alarm until the next cold start. load() cancels that alarm and
      // re-arms the rest from the synced completions.
      useHabitsStore.getState().load(),
    ]);
  } catch (e) {
    // Reload failures shouldn't surface as sync errors — the data IS in Dexie,
    // we just couldn't refresh in-memory state. Log for diagnostics; next
    // navigation / app restart will pick it up.
    console.warn('[sync] data-store reload after pull failed:', e);
  }
}

interface SyncStore {
  isOnline: boolean;
  lastSyncedAt: string | null;
  pendingCount: number;
  syncing: boolean;
  lastError: string | null;
  lastPush: PushResult | null;
  lastPull: PullResult | null;
  // Most recent error messages from individual queue items, for diagnostics UI.
  itemErrors: { entityType: string; entityId: string; message: string }[];

  init: () => void;
  refreshPending: () => Promise<void>;
  syncNow: () => Promise<void>;
}

// v1.16 (NCC#58). Concurrent `syncNow` calls must neither no-op nor overlap.
// The old hand-rolled promise chain got the first right (adoption's syncNow
// was once skipped because App.tsx's auto-sync was already running) and the
// second wrong: every caller waiting on the in-flight sync woke up and started
// its own, so N waiters meant N concurrent full syncs pushing the same queue.
// `coalesce` runs one sync at a time and folds everyone who asks during it
// into a single follow-up run. See src/lib/coalesce.ts.
let requestSync: (() => Promise<void>) | null = null;

async function runSync(set: StoreApi<SyncStore>['setState']): Promise<void> {
  if (!navigator.onLine) return;
  const user = useSessionStore.getState().user;
  if (!user) {
    set({ lastError: 'Not signed in.' });
    return;
  }
  // v1.18.1 — account switch: the adoption choice comes first. Before this
  // account has answered "Existing data found", a sync would load the device's
  // rows into the stores and arm task reminders from them. The `online`, 30 s
  // and window-focus triggers can fire that early; App.tsx starts the first
  // sync once the answer is in.
  if (!adoptionClearFor(user.id)) return;

  set({ syncing: true, lastError: null });
  try {
    const { push, pull } = await fullSync(user.id);
    // After a successful pull, refresh in-memory state in every data
    // store so the UI reflects rows that just landed in Dexie (whether
    // from another device, Realtime, or an external app writing into
    // the shared Supabase project). Skip the reload if the pull failed
    // hard — nothing new would be there to surface anyway.
    if (pull.errors.length === 0) {
      await reloadDataStores();
      // v1.18.1 (NCC#186) — tasks that arrived with this pull get their
      // reminders. AppShell's mount reconcile runs before the first pull, so
      // after a sign-in on a wiped device (or a new account's first sync)
      // they had none until the next app start. A no-op when the tasks are
      // the ones already armed. Only while this sync's user is still signed
      // in: a sign-out in the meantime has cancelled every reminder and must
      // not see them re-armed.
      const stillSignedIn = () => useSessionStore.getState().user?.id === user.id;
      if (stillSignedIn()) {
        void reconcileTaskRemindersIfChanged(useTaskStore.getState().tasks, stillSignedIn).catch((e) =>
          console.warn('[sync] task reminder reconcile failed:', (e as Error).message),
        );
      }
    }
    const pending = await listOwnPending();
    // Surface up to 5 of the most recent item errors for diagnostics.
    const itemErrors = pending
      .filter((p) => p.lastError)
      .slice(-5)
      .map((p) => ({
        entityType: p.entityType,
        entityId: p.entityId,
        message: p.lastError ?? 'unknown',
      }));
    const now = new Date().toISOString();
    localStorage.setItem('sync.lastSyncedAt', now);
    set({
      lastSyncedAt: now,
      pendingCount: pending.length,
      lastPush: push,
      lastPull: pull,
      syncing: false,
      itemErrors,
      lastError:
        push.errors.length > 0
          ? `${push.errors.length} item(s) failed to upload.`
          : pull.errors.length > 0
            ? `Pull error: ${pull.errors[0]}`
            : null,
    });
  } catch (e) {
    set({ syncing: false, lastError: (e as Error).message });
  }
}

export const useSyncStore = create<SyncStore>((set, get) => ({
  isOnline: navigator.onLine,
  lastSyncedAt: localStorage.getItem('sync.lastSyncedAt'),
  pendingCount: 0,
  syncing: false,
  lastError: null,
  lastPush: null,
  lastPull: null,
  itemErrors: [],

  init() {
    const update = () => {
      const wasOnline = get().isOnline;
      const nowOnline = navigator.onLine;
      set({ isOnline: nowOnline });
      if (!wasOnline && nowOnline && get().pendingCount > 0) {
        void get().syncNow();
      }
    };
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    get().refreshPending();

    // Background flusher: every 30s, if online + signed in + pending > 0 and
    // not currently syncing, try to flush. Catches the case where the user
    // adds data, leaves the app, comes back — we want their changes uploaded
    // without them ever thinking about it.
    setInterval(() => {
      const s = get();
      if (s.isOnline && s.pendingCount > 0 && !s.syncing) {
        void s.syncNow();
      }
    }, 30_000);

    // NCC#53 — pull when the user comes back to the window. Every trigger
    // above is gated on pendingCount > 0, so with nothing pending locally the
    // only pull after sign-in was the realtime channel's — and that channel
    // has delivered nothing since v1.2.1 (habits, habit_completions and
    // body_metrics are not in the supabase_realtime publication, and the
    // server rejects the whole channel for one missing table;
    // Limekana/limecore#24). An open tab, desktop window or resumed app
    // therefore showed StudyDesk/LimeLog/other-device data as of launch.
    //
    // `focus` as well as `visibilitychange` for the desktop edition, where
    // switching windows never changes visibility. Throttled: syncNow is a full
    // push + pull, and alt-tabbing is constant. Starts armed at init so the
    // launch sync in App.tsx is not immediately doubled.
    let lastReturnSyncAt = Date.now();
    const RETURN_SYNC_MIN_MS = 30_000;
    const onReturn = () => {
      if (document.visibilityState === 'hidden') return;
      const s = get();
      if (!s.isOnline || s.syncing) return;
      // syncNow records "Not signed in." as an error; a guest returning to the
      // window has nothing to pull and should not see one.
      if (!useSessionStore.getState().user) return;
      const now = Date.now();
      if (now - lastReturnSyncAt < RETURN_SYNC_MIN_MS) return;
      lastReturnSyncAt = now;
      void s.syncNow();
    };
    document.addEventListener('visibilitychange', onReturn);
    window.addEventListener('focus', onReturn);
  },

  async refreshPending() {
    const pending = await listOwnPending();
    set({ pendingCount: pending.length });
  },

  syncNow() {
    requestSync ??= coalesce(() => runSync(set));
    return requestSync();
  },
}));

