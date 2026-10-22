import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import Dexie from 'dexie';

// v1.18.1 (NCC#186) — the whole round trip, with the real reminder modules,
// stores and Dexie, and an in-memory stand-in for the native plugin:
//   sign-out cancels every task + habit reminder;
//   the same account signing back in gets them back without an app restart
//   (Keep: AppShell's mount + habits load; Wipe: the post-sync reconcile);
//   an account switch through "Existing data found" → Discard leaves none of
//   the previous account's reminders behind.

const alarms = vi.hoisted(() => new Map<number, { title: string; channelId: string }>());

vi.mock('@capacitor/core', async (orig) => ({
  ...(await orig<typeof import('@capacitor/core')>()),
  Capacitor: { isNativePlatform: () => true, getPlatform: () => 'android' },
}));
vi.mock('./nexusNotificationsPlugin', () => ({
  NexusNotifications: {
    checkPermission: async () => ({ granted: true }),
    createChannel: async () => {},
    schedule: async (spec: { id: number; title: string; channelId: string }) => {
      alarms.set(spec.id, { title: spec.title, channelId: spec.channelId });
      return { id: spec.id, at: 0 };
    },
    cancel: async ({ ids }: { ids: number[] }) => {
      for (const id of ids) alarms.delete(id);
    },
    getPending: async () => ({ ids: [...alarms.keys()] }),
  },
}));
// CI's Node 20 has no WebSocket; nothing here talks to Supabase.
vi.mock('./supabase', () => ({ supabase: {} }));
vi.mock('./entitlement', () => ({ clearEntitlement: () => {} }));
vi.mock('../store/useSettingsStore', () => ({
  // v1.18.2 merge: `loaded` too, for scheduleNotification's master-switch gate (NCC#151).
  useSettingsStore: { getState: () => ({ loaded: true, notifMasterEnabled: true, notifTasksEnabled: true }) },
}));

const { db, clearAllLocalData } = await import('../db/database');
const { cancelAllReminders } = await import('./notifications');
const { reconcileTaskReminders, reconcileTaskRemindersIfChanged } = await import('./taskReminders');
const { useTaskStore } = await import('../store/useTaskStore');
const { useHabitsStore } = await import('../store/useHabitsStore');
import type { Task } from '../types/tasks';
import type { Habit } from '../types/habits';

function tomorrow(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const NOW = new Date().toISOString();
const task = (id: string, title: string): Task => ({
  id, title, dueDate: tomorrow(), priority: 'medium', completed: false,
  syncStatus: 'synced', createdAt: NOW, updatedAt: NOW,
});
const habit = (id: string, title: string): Habit => ({
  id, title, type: 'binary', frequencyKind: 'daily', reminderTime: '07:30',
  syncStatus: 'synced', createdAt: NOW, updatedAt: NOW,
});

const titles = () => [...alarms.values()].map((a) => a.title).join(' | ');
const channels = () => new Set([...alarms.values()].map((a) => a.channelId));

/** What AppShell's mount does for these two kinds (tasks reconcile after the
 *  store load; habits arm inside load()). */
async function mount() {
  await useTaskStore.getState().load();
  await reconcileTaskReminders(useTaskStore.getState().tasks);
  await useHabitsStore.getState().load();
  await vi.waitFor(() => expect(channels().has('habits') || useHabitsStore.getState().habits.length === 0).toBe(true));
}

beforeAll(async () => {
  await Dexie.delete('nexus_dashboard');
  await db.open();
});
afterAll(async () => {
  db.close();
  await Dexie.delete('nexus_dashboard');
});
beforeEach(async () => {
  alarms.clear();
  await db.tasks.clear();
  await db.habits.clear();
  await db.habitCompletions.clear();
});

describe('sign-out and reminders (NCC#186)', () => {
  it('Keep: sign-out cancels task + habit reminders, the next sign-in re-arms them without a restart', async () => {
    await db.tasks.put(task('t-a', 'A: dentist'));
    await db.habits.put(habit('h-a', 'A: stretch'));
    await mount();
    expect(channels()).toEqual(new Set(['tasks', 'habits']));

    await cancelAllReminders(); // useSessionStore.signOut
    expect(alarms.size).toBe(0);

    await mount(); // same account signs in; Keep left the rows in Dexie
    expect(titles()).toContain('A: dentist');
    expect(channels()).toEqual(new Set(['tasks', 'habits']));
    // The post-sync reconcile sees the same tasks already armed and skips.
    await expect(reconcileTaskRemindersIfChanged(useTaskStore.getState().tasks)).resolves.toBe(false);
  });

  it('Wipe: tasks that arrive with the first pull get their reminders', async () => {
    await mount(); // after the wipe, the mount finds nothing
    expect(alarms.size).toBe(0);

    await db.tasks.put(task('t-a', 'A: dentist')); // the pull lands
    await useTaskStore.getState().load(); // reloadDataStores
    await expect(reconcileTaskRemindersIfChanged(useTaskStore.getState().tasks)).resolves.toBe(true);
    expect(titles()).toContain('A: dentist');
    // A second sync with nothing new does no work.
    await expect(reconcileTaskRemindersIfChanged(useTaskStore.getState().tasks)).resolves.toBe(false);
  });

  it('an involuntary sign-out (no reload) makes the post-sync reconcile re-arm unchanged tasks', async () => {
    await db.tasks.put(task('t-a', 'A: dentist'));
    await mount();
    await cancelAllReminders(); // SIGNED_OUT listener
    expect(alarms.size).toBe(0);
    await expect(reconcileTaskRemindersIfChanged(useTaskStore.getState().tasks)).resolves.toBe(true);
    expect(titles()).toContain('A: dentist');
  });

  it('a sync that finishes after the sign-out arms nothing', async () => {
    await db.tasks.put(task('t-a', 'A: dentist'));
    await useTaskStore.getState().load();
    await cancelAllReminders();
    await reconcileTaskRemindersIfChanged(useTaskStore.getState().tasks, () => false);
    expect(alarms.size).toBe(0);
  });

  it('account switch: Discard in "Existing data found" leaves none of A\'s reminders', async () => {
    // A signed out with Keep; B signs in and the mount arms A's rows.
    await db.tasks.put(task('t-a', 'A: dentist'));
    await db.habits.put(habit('h-a', 'A: stretch'));
    await mount();
    expect(titles()).toContain('A:');

    await clearAllLocalData(); // AdoptionPrompt onDiscard, then reload
    expect(alarms.size).toBe(0);

    await mount(); // after the reload: empty Dexie
    await db.tasks.put(task('t-b', 'B: invoice')); // B's own rows arrive
    await db.habits.put(habit('h-b', 'B: run'));
    await useHabitsStore.getState().load(); // hydrateHabitsFromCloud → load
    await useTaskStore.getState().load();
    await reconcileTaskRemindersIfChanged(useTaskStore.getState().tasks);
    await vi.waitFor(() => expect(channels()).toEqual(new Set(['tasks', 'habits'])));
    expect(titles()).toContain('B: invoice');
    expect(titles()).not.toContain('A:');
  });
});
