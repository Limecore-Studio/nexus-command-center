import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// v1.18.1 (NCC#186) — cancelAllReminders is what sign-out, the involuntary
// SIGNED_OUT, clearAllLocalData and the Settings master switch all call. It
// must reach every category and must never throw or hang the caller.

const plugin = vi.hoisted(() => ({
  pending: [] as number[],
  cancelled: [] as number[][],
  getPending: null as null | (() => Promise<{ ids: number[] }>),
  permission: null as null | Promise<{ granted: boolean }>,
  scheduled: [] as number[],
}));

vi.mock('@capacitor/core', async (orig) => ({
  ...(await orig<typeof import('@capacitor/core')>()),
  Capacitor: { isNativePlatform: () => true, getPlatform: () => 'android' },
}));
// v1.18.2 merge: scheduleNotification also checks the master switch (NCC#151).
vi.mock('../store/useSettingsStore', () => ({
  useSettingsStore: { getState: () => ({ loaded: true, notifMasterEnabled: true }) },
}));
vi.mock('./nexusNotificationsPlugin', () => ({
  NexusNotifications: {
    getPending: () => (plugin.getPending ? plugin.getPending() : Promise.resolve({ ids: [...plugin.pending] })),
    checkPermission: () => plugin.permission ?? Promise.resolve({ granted: true }),
    createChannel: async () => {},
    schedule: async ({ id }: { id: number }) => {
      plugin.scheduled.push(id);
      plugin.pending.push(id);
      return { id, at: 0 };
    },
    cancel: async ({ ids }: { ids: number[] }) => {
      plugin.cancelled.push(ids);
      plugin.pending = plugin.pending.filter((id) => !ids.includes(id));
    },
  },
}));

const { cancelAllReminders, reminderEpoch, ID_RANGES, CANCEL_ALL_WAIT_MS, scheduleNotification, setReminderAudience } =
  await import('./notifications');

beforeEach(() => {
  plugin.pending = [];
  plugin.cancelled = [];
  plugin.getPending = null;
  plugin.permission = null;
  plugin.scheduled = [];
  setReminderAudience(() => true);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('cancelAllReminders (NCC#186)', () => {
  it('cancels a reminder in every category, in one call', async () => {
    // One live ID in each category's range, including habits and insights,
    // which the master switch's hand-written list used to miss.
    plugin.pending = Object.values(ID_RANGES).map((r) => r.base + 1);
    expect(plugin.pending.length).toBe(Object.keys(ID_RANGES).length);
    await expect(cancelAllReminders()).resolves.toBe(true);
    expect(plugin.cancelled).toHaveLength(1);
    expect([...plugin.cancelled[0]].sort()).toEqual(Object.values(ID_RANGES).map((r) => r.base + 1).sort());
    expect(plugin.pending).toEqual([]);
  });

  it('makes no cancel call when nothing is scheduled', async () => {
    await expect(cancelAllReminders()).resolves.toBe(true);
    expect(plugin.cancelled).toEqual([]);
  });

  it('logs and resolves when the plugin fails', async () => {
    plugin.getPending = () => Promise.reject(new Error('bridge down'));
    await expect(cancelAllReminders()).resolves.toBe(false);
    expect(console.warn).toHaveBeenCalled();
  });

  it('logs and resolves when the plugin throws synchronously', async () => {
    plugin.getPending = () => {
      throw new Error('not implemented');
    };
    await expect(cancelAllReminders()).resolves.toBe(false);
  });

  it('gives up on a wedged bridge after the cap instead of holding the caller', async () => {
    vi.useFakeTimers();
    plugin.getPending = () => new Promise(() => {});
    const p = cancelAllReminders();
    await vi.advanceTimersByTimeAsync(CANCEL_ALL_WAIT_MS);
    await expect(p).resolves.toBe(false);
  });

  it('bumps the epoch, so "already armed" memories go stale', async () => {
    const before = reminderEpoch();
    await cancelAllReminders();
    expect(reminderEpoch()).toBe(before + 1);
  });
});

describe('scheduleNotification gate (NCC#186)', () => {
  const opts = { id: 4001, category: 'portfolio-eod' as const, title: "A's recap", body: '+1.2%' };

  it('a schedule whose await resolves after cancelAllReminders does not reach the plugin', async () => {
    let grant!: (v: { granted: boolean }) => void;
    plugin.permission = new Promise((r) => (grant = r));
    const p = scheduleNotification(opts); // e.g. an EoD tick in flight
    await cancelAllReminders(); // the involuntary SIGNED_OUT
    grant({ granted: true });
    await expect(p).resolves.toMatchObject({ ok: false });
    expect(plugin.scheduled).toEqual([]);
    expect(plugin.pending).toEqual([]);
  });

  it('refuses while nobody is signed in and the app is not in guest mode', async () => {
    setReminderAudience(() => false);
    await expect(scheduleNotification(opts)).resolves.toMatchObject({ ok: false, reason: 'Nobody is signed in.' });
    expect(plugin.scheduled).toEqual([]);
  });

  it('schedules normally otherwise, including right after a cancel', async () => {
    await cancelAllReminders();
    await expect(scheduleNotification(opts)).resolves.toEqual({ ok: true });
    expect(plugin.scheduled).toEqual([4001]);
  });
});
