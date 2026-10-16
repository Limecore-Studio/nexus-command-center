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
//   NCC#168 — a specific-days habit reminder was one-shot.

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

const {
  reconcileHabitReminders,
  habitReminderIds,
  scheduleHabitReminder,
  habitWeekdayReminderId,
  ownedHabitReminderIds,
} = await import('./habitReminders');
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

  // v1.18.1 (NCC#168): was one-shot with streak-aware copy; it repeats
  // weekly now, so it takes the streak-free copy too.
  it('a specific-days habit repeats weekly per day, with that copy', async () => {
    const { a } = collidingIds();
    await scheduleHabitReminder(
      habit(a, { frequencyKind: 'specific_days', daysOfWeek: [0, 1, 2, 3, 4, 5, 6] }),
      12,
      false,
    );
    expect(scheduledIds()).not.toContain(habitReminderIds(a)[0]);
    const specs = plugin.schedule.mock.calls.map((c) => c[0]);
    expect(specs).toHaveLength(7);
    for (const spec of specs) {
      expect(spec).toMatchObject({ every: 'week' });
      expect(`${spec.title} ${spec.body}`).not.toMatch(/12|streak/i);
    }
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

describe('a specific-days habit reminder repeats weekly, one alarm per day (NCC#168)', () => {
  const weekdays = [0, 1, 2, 3, 4, 5, 6];
  const specific = (id: string, daysOfWeek: number[], patch: Partial<Habit> = {}) =>
    habit(id, { frequencyKind: 'specific_days', daysOfWeek, ...patch });
  const scheduledSpecs = () => plugin.schedule.mock.calls.map((c) => c[0]);

  afterEach(() => {
    vi.useRealTimers();
  });

  it('gives each weekday its own ID, in its own sub-range of the habits range', () => {
    const otherRanges = Object.entries(ID_RANGES).filter(([k]) => k !== 'habits');
    for (let i = 0; i < 400; i++) {
      const id = `h-${i}`;
      const days = weekdays.map((d) => habitWeekdayReminderId(id, d));
      expect(new Set(days).size).toBe(7);
      expect(days.every((x, d) => x === days[0] + d)).toBe(true); // weekday-ordered
      for (const x of days) {
        expect(x).toBeGreaterThanOrEqual(ID_RANGES.habits.base + 1000);
        expect(x).toBeLessThan(ID_RANGES.habits.base + ID_RANGES.habits.size);
        for (const [, r] of otherRanges) expect(x >= r.base && x < r.base + r.size).toBe(false);
        // never one of the daily IDs (8000-8899) or the milestones (8990-8998)
        expect(habitReminderIds(id)).not.toContain(x);
      }
    }
  });

  it('two habits share weekday IDs only when they share a slot', () => {
    const { a, b, others } = collidingIds();
    expect(habitWeekdayReminderId(a, 3)).toBe(habitWeekdayReminderId(b, 3));
    for (const o of others) expect(habitWeekdayReminderId(o, 3)).not.toBe(habitWeekdayReminderId(a, 3));
  });

  it('the highest weekday ID is accepted by the habits range check', async () => {
    const top = ID_RANGES.habits.base + 1000 + 299 * 7 + 6;
    expect(top).toBe(ID_RANGES.habits.base + ID_RANGES.habits.size - 1);
    const r = await scheduleNotification({
      id: top,
      category: 'habits',
      title: 't',
      body: 'b',
      at: new Date(Date.now() + 60_000),
    });
    expect(r.ok).toBe(true);
  });

  it('arms the chosen days only, each weekly at its own weekday and time; today, once past, is next week', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 21, 9, 0)); // Wednesday 09:00
    const { a } = collidingIds();
    await scheduleHabitReminder(specific(a, [5, 1, 3], { reminderTime: '07:30' }), 4, false);

    const specs = scheduledSpecs();
    expect(specs.map((s) => s.id)).toEqual([5, 1, 3].map((d) => habitWeekdayReminderId(a, d)));
    for (const s of specs) expect(s).toMatchObject({ every: 'week', hour: 7, minute: 30 });
    const at = Object.fromEntries(specs.map((s) => [s.weekday, s.atMillis]));
    expect(at[1]).toBe(new Date(2026, 9, 26, 7, 30).getTime()); // next Monday
    expect(at[3]).toBe(new Date(2026, 9, 28, 7, 30).getTime()); // today was 07:30: +7 days
    expect(at[5]).toBe(new Date(2026, 9, 23, 7, 30).getTime()); // this Friday
    // Nothing is cancelled by scheduling (NCC#178): reconcile does that.
    expect(plugin.cancel).not.toHaveBeenCalled();
  });

  it("arms today's alarm today while its time is still ahead", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 21, 7, 29)); // Wednesday 07:29
    const { a } = collidingIds();
    await scheduleHabitReminder(specific(a, [3], { reminderTime: '07:30' }), 0, false);
    expect(scheduledSpecs()[0].atMillis).toBe(new Date(2026, 9, 21, 7, 30).getTime());
  });

  it('does not cancel the alarms of a habit of the other kind that shares the slot (NCC#178)', async () => {
    const { a, b } = collidingIds();
    const daily = habit(a);
    const weekly = specific(b, [2, 4]);
    plugin.pending = [...habitReminderIds(a), habitWeekdayReminderId(b, 2), habitWeekdayReminderId(b, 4)];
    await scheduleHabitReminder(daily, 3, false);
    await scheduleHabitReminder(weekly, 3, false);
    await reconcileHabitReminders([daily, weekly]);
    expect(cancelledIds().filter((id) => plugin.pending.includes(id))).toEqual([]);
  });

  it('editing the days arms an added day, and reconcile cancels the dropped one', async () => {
    const { a } = collidingIds();
    await db.habits.put(specific(a, [1, 3]));
    useHabitsStore.setState({ habits: [specific(a, [1, 3])], loaded: true });
    plugin.pending = [habitWeekdayReminderId(a, 1), habitWeekdayReminderId(a, 3)];

    await useHabitsStore.getState().updateHabit(a, { daysOfWeek: [1, 5] });
    await vi.waitFor(() => expect(scheduledIds()).toContain(habitWeekdayReminderId(a, 5)));
    expect(scheduledIds()).toContain(habitWeekdayReminderId(a, 1));
    expect(scheduledIds()).not.toContain(habitWeekdayReminderId(a, 3));
    await vi.waitFor(() => expect(cancelledIds()).toEqual([habitWeekdayReminderId(a, 3)]));
  });

  it('switching to daily cancels the weekday alarms, and back again the daily ones', async () => {
    const { a } = collidingIds();
    await db.habits.put(specific(a, [0, 6]));
    useHabitsStore.setState({ habits: [specific(a, [0, 6])], loaded: true });
    plugin.pending = [habitWeekdayReminderId(a, 0), habitWeekdayReminderId(a, 6)];

    await useHabitsStore.getState().updateHabit(a, { frequencyKind: 'daily' });
    await vi.waitFor(() => {
      expect(cancelledIds()).toContain(habitWeekdayReminderId(a, 0));
      expect(cancelledIds()).toContain(habitWeekdayReminderId(a, 6));
    });

    plugin.cancel.mockClear();
    plugin.pending = habitReminderIds(a);
    await useHabitsStore.getState().updateHabit(a, { frequencyKind: 'specific_days' });
    await vi.waitFor(() => expect(new Set(cancelledIds())).toEqual(new Set(habitReminderIds(a))));
  });

  it('deleting, archiving or clearing the reminder cancels every per-day alarm', async () => {
    const { others } = collidingIds();
    const [del, arch, clr] = others;
    for (const id of others) await db.habits.put(specific(id, [0, 2, 4]));
    useHabitsStore.setState({ habits: others.map((id) => specific(id, [0, 2, 4])), loaded: true });
    plugin.pending = others.flatMap((id) => [0, 2, 4].map((d) => habitWeekdayReminderId(id, d)));

    await useHabitsStore.getState().deleteHabit(del);
    await useHabitsStore.getState().archiveHabit(arch);
    await useHabitsStore.getState().updateHabit(clr, { reminderTime: undefined });

    await vi.waitFor(() => {
      for (const id of [del, arch, clr]) {
        for (const d of [0, 2, 4]) expect(cancelledIds()).toContain(habitWeekdayReminderId(id, d));
      }
    });
    expect(plugin.schedule).not.toHaveBeenCalled();
  });

  it('reconcile keeps the chosen days and cancels a dropped day, a kind switch and the old one-shot', async () => {
    const { others } = collidingIds();
    const [spec, wasSpecific] = others;
    const milestone = ID_RANGES.habits.base + 993;
    plugin.pending = [
      habitWeekdayReminderId(spec, 1),
      habitWeekdayReminderId(spec, 3), // a day dropped on another device
      habitReminderIds(spec)[0], // the one-shot primary from before NCC#168
      ...habitReminderIds(wasSpecific),
      habitWeekdayReminderId(wasSpecific, 2), // now daily
      milestone,
    ];
    await reconcileHabitReminders([specific(spec, [1, 5]), habit(wasSpecific)]);

    expect(new Set(cancelledIds())).toEqual(
      new Set([habitWeekdayReminderId(spec, 3), habitReminderIds(spec)[0], habitWeekdayReminderId(wasSpecific, 2)]),
    );
    expect(ownedHabitReminderIds(specific(spec, [1, 5, 5, 9]))).toEqual([
      habitWeekdayReminderId(spec, 1),
      habitWeekdayReminderId(spec, 5),
    ]);
  });
});
