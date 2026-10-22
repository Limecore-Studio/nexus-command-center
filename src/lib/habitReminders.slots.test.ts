import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Habit } from '../types/habits';

// v1.18.1 (NCC#178) — habit reminder slots were hash(id) % 300, so two habits
// could share alarm IDs and overwrite each other's alarms. They are assigned
// now, from a per-device map in Capacitor Preferences.

const plugin = vi.hoisted(() => ({
  pending: [] as number[],
  schedule: vi.fn(async (_spec: Record<string, unknown>) => ({})),
  cancel: vi.fn(async (_spec: { ids: number[] }) => {}),
  getPending: vi.fn(async () => ({ ids: plugin.pending })),
}));
// Survives vi.resetModules(), like SharedPreferences survives a restart.
const prefs = vi.hoisted(() => ({ values: {} as Record<string, string> }));

vi.mock('@capacitor/core', async (orig) => ({
  ...(await orig<typeof import('@capacitor/core')>()),
  Capacitor: { isNativePlatform: () => true, getPlatform: () => 'android' },
}));
vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: async ({ key }: { key: string }) => ({ value: prefs.values[key] ?? null }),
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
    getPending: plugin.getPending,
  },
}));
vi.mock('./supabase', () => ({ supabase: {} }));
vi.stubGlobal('document', {
  documentElement: { style: { setProperty: () => {}, removeProperty: () => {} } },
});

const KEY = 'habits.reminderSlots';
type Mod = typeof import('./habitReminders');

/** A fresh module, as on an app start: the slot map is read from prefs. */
async function start(): Promise<Mod> {
  vi.resetModules();
  const { useSettingsStore } = await import('../store/useSettingsStore');
  useSettingsStore.setState({ loaded: true, notifMasterEnabled: true });
  const mod = await import('./habitReminders');
  await mod.loadHabitSlots();
  return mod;
}

function habit(id: string, patch: Partial<Habit> = {}): Habit {
  return {
    id,
    title: `Habit ${id}`,
    type: 'binary',
    frequencyKind: 'daily',
    reminderTime: '07:30',
    syncStatus: 'synced',
    createdAt: '2026-10-01T08:00:00.000Z',
    updatedAt: '2026-10-01T08:00:00.000Z',
    ...patch,
  };
}

const settle = () => new Promise((r) => setTimeout(r, 10));
const saved = () => JSON.parse(prefs.values[KEY] ?? '{}') as Record<string, number>;
const scheduledIds = () => plugin.schedule.mock.calls.map((c) => c[0].id as number);
const cancelledIds = () => plugin.cancel.mock.calls.flatMap((c) => c[0].ids);
const ids = (n: number, p = 'h') => Array.from({ length: n }, (_, i) => `${p}-${i}`);

beforeEach(() => {
  prefs.values = {};
  plugin.pending = [];
  plugin.schedule.mockClear();
  plugin.cancel.mockReset();
  plugin.getPending.mockReset();
  plugin.getPending.mockImplementation(async () => ({ ids: plugin.pending }));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await settle();
});

describe('habit reminder slots (NCC#178)', () => {
  it('gives every habit IDs of its own, for 10 and for 300 habits', async () => {
    const m = await start();
    // Under the hash, 10 habits shared a slot ~14% of the time; 300 nearly always.
    for (const n of [10, 300]) {
      const habits = ids(n, `n${n}`).map((id, i) =>
        habit(id, i % 2 ? {} : { frequencyKind: 'specific_days', daysOfWeek: [0, 1, 2, 3, 4, 5, 6] }),
      );
      const all = habits.flatMap((h) => m.ownedHabitReminderIds(h));
      expect(new Set(all).size).toBe(all.length);
      expect(all.length).toBe(Math.ceil(n / 2) * 7 + Math.floor(n / 2) * 3);
      await m.reconcileHabitReminders([]); // frees them all for the next n
    }
  });

  it('two habits whose hashes collide do not overwrite each other', async () => {
    const m = await start();
    const byHash = new Map<number, string>();
    let pair: [string, string] | undefined;
    for (let i = 0; !pair; i++) {
      const prior = byHash.get(m.habitHashSlot(`c-${i}`));
      if (prior) pair = [prior, `c-${i}`];
      else byHash.set(m.habitHashSlot(`c-${i}`), `c-${i}`);
    }
    for (const id of pair) await m.scheduleHabitReminder(habit(id));
    const primaries = scheduledIds().filter((id) => id < 8900 && (id - 8000) % 3 === 0);
    expect(new Set(primaries).size).toBe(2);
  });

  it('keeps a habit on its slot across restarts, whatever order habits ask in', async () => {
    let m = await start();
    const list = ids(20);
    const before = list.map((id) => m.habitReminderIds(id));
    await settle();
    expect(Object.keys(saved())).toHaveLength(20);

    m = await start();
    const after = [...list].reverse().map((id) => m.habitReminderIds(id)).reverse();
    expect(after).toEqual(before);
  });

  it('frees a slot once its habit is deleted, archived or cleared, after cancelling its alarms', async () => {
    const m = await start();
    const [keep, del, arch, clr] = ['keep', 'del', 'arch', 'clr'].map((id) => habit(id));
    plugin.pending = [keep, del, arch, clr].flatMap((h) => m.ownedHabitReminderIds(h));
    const old = { del: m.habitReminderIds('del'), arch: m.habitReminderIds('arch'), clr: m.habitReminderIds('clr') };
    let heldAtCancel: string[] = [];
    plugin.cancel.mockImplementationOnce(async () => {
      heldAtCancel = Object.keys(saved());
    });
    await settle();

    await m.reconcileHabitReminders([keep, { ...arch, archivedAt: '2026-10-02' }, { ...clr, reminderTime: undefined }]);
    expect(new Set(cancelledIds())).toEqual(new Set([...old.del, ...old.arch, ...old.clr]));
    expect(heldAtCancel.sort()).toEqual(['arch', 'clr', 'del', 'keep']);
    await settle();
    expect(Object.keys(saved())).toEqual(['keep']);
  });

  it('reuses a freed slot, and past 300 habits skips the extra one and logs it', async () => {
    const m = await start();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const full = ids(300).map((id) => habit(id));
    for (const h of full) m.ownedHabitReminderIds(h);

    const extra = habit('extra');
    expect(m.ownedHabitReminderIds(extra)).toEqual([]);
    expect(m.habitReminderIds('extra')).toEqual([]);
    await m.scheduleHabitReminder(extra);
    expect(plugin.schedule).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no free reminder slot'), 'extra');
    // The others keep working.
    await m.scheduleHabitReminder(full[7]);
    expect(scheduledIds()).toContain(m.habitReminderIds('h-7')[0]);

    const freed = m.habitReminderIds('h-123');
    await m.reconcileHabitReminders(full.filter((h) => h.id !== 'h-123'));
    expect(m.habitReminderIds('extra')).toEqual(freed);
  });

  it('upgrade: keeps every free hash slot, moves colliding habits oldest-first, and cancels what they left', async () => {
    let m = await start();
    const find = (pred: (id: string) => boolean, p: string) => {
      for (let i = 0; ; i++) if (pred(`${p}-${i}`)) return `${p}-${i}`;
    };
    // a and b share a hash slot; c's hash slot is 0, the lowest free one.
    const aId = find((id) => m.habitHashSlot(id) > 2, 'a');
    const bId = find((id) => m.habitHashSlot(id) === m.habitHashSlot(aId), 'b');
    const cId = find((id) => m.habitHashSlot(id) === 0, 'c');
    const hashDaily = (id: string) => [0, 1, 2].map((k) => 8000 + m.habitHashSlot(id) * 3 + k);
    const hashWeekday = (id: string, d: number) => 9000 + m.habitHashSlot(id) * 7 + d;
    const a = habit(aId, { createdAt: '2026-01-01' }); // daily, oldest
    const b = habit(bId, { createdAt: '2026-02-01', frequencyKind: 'specific_days', daysOfWeek: [1, 4] });
    const c = habit(cId, { createdAt: '2026-03-01' });

    for (const order of [[c, b, a], [a, b, c]]) {
      prefs.values = {}; // v1.18.0: no map yet
      plugin.cancel.mockClear();
      plugin.schedule.mockClear();
      // What v1.18.0 left pending, under hashed IDs.
      plugin.pending = [...hashDaily(aId), hashWeekday(bId, 1), hashWeekday(bId, 4), ...hashDaily(cId)];
      m = await start();
      // As load() does: reconcile, then every re-arm, none awaited.
      const runs = [m.reconcileHabitReminders(order), ...order.map((h) => m.scheduleHabitReminder(h))];
      await Promise.all(runs);

      expect(m.habitReminderIds(aId)).toEqual(hashDaily(aId));
      expect(m.habitReminderIds(cId)).toEqual(hashDaily(cId)); // not displaced by b
      expect(m.habitWeekdayReminderId(bId, 1)).toBe(9000 + 1 * 7 + 1); // lowest free: 1
      expect(scheduledIds()).toEqual(
        expect.arrayContaining([hashDaily(aId)[0], m.habitWeekdayReminderId(bId, 1), m.habitWeekdayReminderId(bId, 4)]),
      );
      // reconcile ran first and cancelled only b's old weekday alarms
      expect(new Set(plugin.cancel.mock.calls[0][0].ids)).toEqual(new Set([hashWeekday(bId, 1), hashWeekday(bId, 4)]));
      await settle();
      expect(saved()).toEqual({ [aId]: m.habitHashSlot(aId), [bId]: 1, [cId]: 0 });
    }
  });

  it('runs schedule and reconcile one at a time, so a stale reconcile cannot cancel a new alarm or free its slot', async () => {
    const m = await start();
    plugin.schedule.mockImplementation(async (spec) => {
      plugin.pending.push(spec.id as number);
      return {};
    });
    // getPending answers late, with what is pending by then.
    plugin.getPending.mockImplementation(async () => {
      await settle();
      return { ids: [...plugin.pending] };
    });
    const added = habit('added');
    // A reconcile from before the habit was added, and its first schedule.
    await Promise.all([m.reconcileHabitReminders([]), m.scheduleHabitReminder(added)]);

    const [primary] = m.habitReminderIds('added');
    expect(scheduledIds()).toContain(primary);
    expect(cancelledIds()).not.toContain(primary);
    await settle();
    expect(saved().added).toBe(m.habitHashSlot('added'));
    plugin.schedule.mockReset();
  });

  it('frees no slot when the pending list or the cancel fails', async () => {
    const m = await start();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const gone = m.habitReminderIds('gone');
    plugin.pending = [...gone];

    plugin.getPending.mockRejectedValueOnce(new Error('binder died'));
    await m.reconcileHabitReminders([]);
    expect(plugin.cancel).not.toHaveBeenCalled();
    await settle();
    expect(Object.keys(saved())).toEqual(['gone']);

    plugin.cancel.mockRejectedValueOnce(new Error('binder died'));
    await m.reconcileHabitReminders([]);
    expect(cancelledIds()).toEqual(gone);
    await settle();
    expect(Object.keys(saved())).toEqual(['gone']);

    await m.reconcileHabitReminders([]); // works this time
    await settle();
    expect(saved()).toEqual({});
  });

  it('ignores a corrupt map and drops a slot listed twice', async () => {
    prefs.values[KEY] = 'not json';
    let m = await start();
    expect(m.habitReminderIds('x')).toEqual([0, 1, 2].map((k) => 8000 + m.habitHashSlot('x') * 3 + k));

    await settle(); // that run's save lands first
    prefs.values[KEY] = JSON.stringify({ first: 5, second: 5, bad: 999 });
    m = await start();
    expect(m.habitReminderIds('first')).toEqual([8015, 8016, 8017]);
    expect(m.habitReminderIds('second')).not.toEqual([8015, 8016, 8017]);
  });
});
