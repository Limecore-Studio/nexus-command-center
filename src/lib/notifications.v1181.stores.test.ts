import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Habit } from '../types/habits';
import type { Task } from '../types/tasks';

// v1.18.1 review fixes, against the real habits, settings and task stores
// (Dexie on fake-indexeddb):
//   B1 — a daily habit alarm outlived the habit when it was archived, deleted
//        or cleared of its reminder on another device (NCC#138).
//   B2 — the master switch was read before settings loaded, and habits were
//        never re-armed when it went back on (NCC#151).
//   S1 — a repeating reminder froze the streak count into its text (NCC#138).
//   S2 — "Mark done" toggled, so a replayed one undid itself (NCC#143).

const plugin = vi.hoisted(() => ({
  pending: [] as number[],
  schedule: vi.fn(async (_spec: Record<string, unknown>) => ({})),
  cancel: vi.fn(async (_spec: { ids: number[] }) => {}),
}));
const prefs = vi.hoisted(() => ({
  values: {} as Record<string, string>,
  get: vi.fn(async ({ key }: { key: string }) => ({ value: prefs.values[key] ?? null })),
}));

vi.mock('@capacitor/core', async (orig) => ({
  ...(await orig<typeof import('@capacitor/core')>()),
  Capacitor: { isNativePlatform: () => true, getPlatform: () => 'android' },
}));
vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: prefs.get,
    set: async ({ key, value }: { key: string; value: string }) => {
      prefs.values[key] = value;
    },
  },
}));
vi.mock('./nexusNotificationsPlugin', () => ({
  NexusNotifications: {
    checkPermission: async () => ({ granted: true }),
    createChannel: async () => {},
    schedule: plugin.schedule,
    cancel: plugin.cancel,
    getPending: async () => ({ ids: plugin.pending }),
  },
}));
// db → entitlement → supabase. CI runs Node 20 without WebSocket, where the
// real client cannot be built.
vi.mock('./supabase', () => ({ supabase: {} }));
// readSettings applies the UI scale to <html>; there is no DOM under node.
vi.stubGlobal('document', {
  documentElement: { style: { setProperty: () => {}, removeProperty: () => {} } },
});

const { reconcileHabitReminders, habitReminderIds, scheduleHabitReminder } = await import('./habitReminders');
const { habitMessage } = await import('./habitMessages');
const { scheduleNotification, ID_RANGES } = await import('./notifications');
const { useHabitsStore, rearmHabitsWhenNotificationsOn } = await import('../store/useHabitsStore');
const { useSettingsStore } = await import('../store/useSettingsStore');
const { useTaskStore } = await import('../store/useTaskStore');
const { db } = await import('../db/database');

const T0 = '2026-10-01T08:00:00.000Z';

function habit(id: string, patch: Partial<Habit> = {}): Habit {
  return {
    id,
    title: `Habit ${id}`,
    type: 'binary',
    frequencyKind: 'daily',
    reminderTime: '07:30',
    syncStatus: 'synced',
    createdAt: T0,
    updatedAt: T0,
    ...patch,
  };
}

/** Two habit ids whose reminders share alarm IDs (slot = hash % 300), and a
 *  few more that share them with neither. Deterministic. */
function collidingIds(): { a: string; b: string; others: string[] } {
  const seen = new Map<number, string>();
  let a = '';
  let b = '';
  for (let i = 0; !a; i++) {
    const id = `habit-${i}`;
    const primary = habitReminderIds(id)[0];
    const prior = seen.get(primary);
    if (prior) {
      a = prior;
      b = id;
    } else {
      seen.set(primary, id);
    }
  }
  const taken = new Set(habitReminderIds(a));
  const others: string[] = [];
  for (let i = 0; others.length < 3; i++) {
    const id = `other-${i}`;
    const ids = habitReminderIds(id);
    if (ids.some((x) => taken.has(x))) continue;
    ids.forEach((x) => taken.add(x));
    others.push(id);
  }
  return { a, b, others };
}

const settle = () => new Promise((r) => setTimeout(r, 20));
const scheduledIds = () => plugin.schedule.mock.calls.map((c) => c[0].id as number);
const cancelledIds = () => plugin.cancel.mock.calls.flatMap((c) => c[0].ids);

beforeEach(async () => {
  plugin.pending = [];
  plugin.schedule.mockClear();
  plugin.cancel.mockClear();
  prefs.values = {};
  prefs.get.mockClear();
  useSettingsStore.setState({ loaded: true, notifMasterEnabled: true });
  useHabitsStore.setState({ habits: [], completions: [], loaded: false });
  await Promise.all([db.habits.clear(), db.habitCompletions.clear(), db.tasks.clear(), db.syncQueue.clear()]);
});

afterEach(async () => {
  await settle(); // let fire-and-forget scheduling finish inside its own test
});

describe('reconcileHabitReminders (B1)', () => {
  it('cancels what no active habit owns, and keeps what one does, collisions included', async () => {
    const { a, b, others } = collidingIds();
    const [archived, cleared, gone] = others;
    const active = habit(a);
    const habits = [
      active,
      habit(b, { archivedAt: T0 }), // shares every ID with `active`
      habit(archived, { archivedAt: T0 }),
      habit(cleared, { reminderTime: undefined }),
      // `gone` was deleted: no row at all, only its alarms are left
    ];
    const milestone = ID_RANGES.habits.base + 995;
    const taskAlarm = ID_RANGES.tasks.base + 1;
    plugin.pending = [
      ...habitReminderIds(a),
      ...habitReminderIds(archived),
      ...habitReminderIds(cleared),
      ...habitReminderIds(gone),
      milestone,
      taskAlarm,
    ];

    await reconcileHabitReminders(habits);

    expect(plugin.cancel).toHaveBeenCalledTimes(1);
    expect(new Set(cancelledIds())).toEqual(
      new Set([...habitReminderIds(archived), ...habitReminderIds(cleared), ...habitReminderIds(gone)]),
    );
    for (const id of habitReminderIds(a)) expect(cancelledIds()).not.toContain(id);
    expect(cancelledIds()).not.toContain(milestone);
    expect(cancelledIds()).not.toContain(taskAlarm);
  });

  it('cancels nothing when every pending alarm is owned', async () => {
    const { a } = collidingIds();
    plugin.pending = habitReminderIds(a);
    await reconcileHabitReminders([habit(a)]);
    expect(plugin.cancel).not.toHaveBeenCalled();
  });

  it('runs on load(): a habit archived on another device loses its alarm', async () => {
    const { a, others } = collidingIds();
    const archivedElsewhere = others[0];
    await db.habits.bulkPut([habit(a), habit(archivedElsewhere, { archivedAt: T0 })]);
    plugin.pending = [...habitReminderIds(a), habitReminderIds(archivedElsewhere)[0]];

    await useHabitsStore.getState().load();

    await vi.waitFor(() => expect(cancelledIds()).toContain(habitReminderIds(archivedElsewhere)[0]));
    const reconcileCall = plugin.cancel.mock.calls.find((c) =>
      c[0].ids.includes(habitReminderIds(archivedElsewhere)[0]),
    )!;
    for (const id of habitReminderIds(a)) expect(reconcileCall[0].ids).not.toContain(id);
    // and the active habit was re-armed
    await vi.waitFor(() => expect(scheduledIds()).toContain(habitReminderIds(a)[0]));
  });
});

describe('the master switch and settings load (B2)', () => {
  it('loads settings before reading the switch, so a cold-start re-arm is not refused', async () => {
    useSettingsStore.setState({ loaded: false, notifMasterEnabled: false });
    prefs.values['settings.notif.master'] = '1';
    const r = await scheduleNotification({
      id: ID_RANGES.habits.base,
      category: 'habits',
      title: 't',
      body: 'b',
      at: new Date(Date.now() + 60_000),
    });
    expect(r.ok).toBe(true);
    expect(useSettingsStore.getState()).toMatchObject({ loaded: true, notifMasterEnabled: true });
  });

  it('shares one settings read between callers that ask at the same time', async () => {
    useSettingsStore.setState({ loaded: false });
    await useSettingsStore.getState().load();
    const perLoad = prefs.get.mock.calls.length;
    expect(perLoad).toBeGreaterThan(0);

    prefs.get.mockClear();
    useSettingsStore.setState({ loaded: false });
    await Promise.all([
      useSettingsStore.getState().load(),
      useSettingsStore.getState().load(),
      useSettingsStore.getState().load(),
    ]);
    expect(prefs.get).toHaveBeenCalledTimes(perLoad);

    // A later call reads again; only concurrent ones are shared.
    await useSettingsStore.getState().load();
    expect(prefs.get).toHaveBeenCalledTimes(perLoad * 2);
  });

  it('re-arms every active habit when the switch turns on, and only then', async () => {
    const { a, others } = collidingIds();
    const [archived] = others;
    useSettingsStore.setState({ notifMasterEnabled: false });
    useHabitsStore.setState({ habits: [habit(a), habit(archived, { archivedAt: T0 })], loaded: true });

    const stop = rearmHabitsWhenNotificationsOn();
    await settle();
    expect(plugin.schedule).not.toHaveBeenCalled();

    useSettingsStore.setState({ notifMasterEnabled: true });
    await vi.waitFor(() => expect(scheduledIds()).toContain(habitReminderIds(a)[0]));
    expect(scheduledIds().some((id) => habitReminderIds(archived).includes(id))).toBe(false);

    // Unrelated changes do not re-arm.
    plugin.schedule.mockClear();
    useSettingsStore.setState({ aiEnabled: true });
    useHabitsStore.setState({ completions: [] });
    await settle();
    expect(plugin.schedule).not.toHaveBeenCalled();

    // Off and on again does.
    useSettingsStore.setState({ notifMasterEnabled: false });
    useSettingsStore.setState({ notifMasterEnabled: true });
    await vi.waitFor(() => expect(scheduledIds()).toContain(habitReminderIds(a)[0]));

    stop();
    plugin.schedule.mockClear();
    useSettingsStore.setState({ notifMasterEnabled: false });
    useSettingsStore.setState({ notifMasterEnabled: true });
    await settle();
    expect(plugin.schedule).not.toHaveBeenCalled();
  });

  it('waits for both stores to load, then re-arms once', async () => {
    const { a } = collidingIds();
    useSettingsStore.setState({ loaded: false, notifMasterEnabled: false });
    const stop = rearmHabitsWhenNotificationsOn();

    useHabitsStore.setState({ habits: [habit(a)], loaded: true });
    await settle();
    expect(plugin.schedule).not.toHaveBeenCalled();

    useSettingsStore.setState({ loaded: true, notifMasterEnabled: true });
    await vi.waitFor(() => expect(scheduledIds()).toContain(habitReminderIds(a)[0]));
    const primaries = () => scheduledIds().filter((id) => id === habitReminderIds(a)[0]).length;
    expect(primaries()).toBe(1);
    stop();
  });
});

describe('a repeating reminder carries no streak (S1)', () => {
  it('has streak-free copy in every rotation', () => {
    for (let seed = 0; seed < 12; seed++) {
      const m = habitMessage('repeating', 'Read', 12, seed);
      expect(`${m.title} ${m.body}`).not.toMatch(/\d|streak/i);
    }
  });

  it('a daily habit repeats its primary with that copy, at its own time of day', async () => {
    const { a } = collidingIds();
    await scheduleHabitReminder(habit(a, { reminderTime: '02:30' }), 12, false);
    const primary = plugin.schedule.mock.calls.find((c) => c[0].id === habitReminderIds(a)[0])![0];
    expect(primary).toMatchObject({ every: 'day', hour: 2, minute: 30 });
    expect(`${primary.title} ${primary.body}`).not.toMatch(/12|streak/i);
  });

  it('a specific-days habit is one-shot and keeps its streak-aware copy', async () => {
    const { a } = collidingIds();
    await scheduleHabitReminder(
      habit(a, { frequencyKind: 'specific_days', daysOfWeek: [0, 1, 2, 3, 4, 5, 6] }),
      12,
      false,
    );
    const primary = plugin.schedule.mock.calls.find((c) => c[0].id === habitReminderIds(a)[0])![0];
    expect(primary).not.toHaveProperty('every');
    expect(primary.title).toContain('12');
  });
});

describe('"Mark done" sets, it does not toggle (S2)', () => {
  const task: Task = {
    id: 'task-1',
    title: 'Pay rent',
    priority: 'medium',
    completed: false,
    syncStatus: 'synced',
    createdAt: T0,
    updatedAt: T0,
  };

  it('completes an open task, and a second "Mark done" leaves it done', async () => {
    await db.tasks.put(task);
    await useTaskStore.getState().setComplete(task.id, true);
    await useTaskStore.getState().setComplete(task.id, true); // the replay
    expect((await db.tasks.get(task.id))?.completed).toBe(true);
    const updates = (await db.syncQueue.toArray()).filter((q) => q.entityId === task.id);
    expect(updates).toHaveLength(1);
  });

  it('does nothing to a task that is already done', async () => {
    await db.tasks.put({ ...task, completed: true });
    await useTaskStore.getState().setComplete(task.id, true);
    expect((await db.tasks.get(task.id))?.completed).toBe(true);
    expect(await db.syncQueue.count()).toBe(0);
  });

  it('leaves toggleComplete a toggle', async () => {
    await db.tasks.put(task);
    await useTaskStore.getState().toggleComplete(task.id);
    expect((await db.tasks.get(task.id))?.completed).toBe(true);
    await useTaskStore.getState().toggleComplete(task.id);
    expect((await db.tasks.get(task.id))?.completed).toBe(false);
  });
});
