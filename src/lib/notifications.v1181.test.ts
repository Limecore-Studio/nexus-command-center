import { describe, it, expect, beforeEach, vi } from 'vitest';

// v1.18.1 — NCC#142 (task reminders never scheduled for a dated-and-timed
// task), NCC#151 (the master switch was ignored by some schedulers) and
// NCC#143 (a notification delivered live stayed in the native buffer and was
// replayed by the next subscription).

type Listener = (event: any) => void;
const plugin = vi.hoisted(() => ({
  listeners: {} as Record<string, Listener>,
  schedule: vi.fn(async (_spec: Record<string, unknown>) => ({})),
  consumePendingTap: vi.fn(async () => ({ route: '' })),
  consumePendingAction: vi.fn(async () => ({ actionId: '', route: '', extraJson: '' })),
  ackPendingTaps: vi.fn(async (_spec: { seqs: number[] }) => {}),
  ackPendingActions: vi.fn(async (_spec: { seqs: number[] }) => {}),
}));
const settings = vi.hoisted(() => ({
  loaded: true,
  notifMasterEnabled: true,
  load: vi.fn(async () => {}),
}));

vi.mock('@capacitor/core', async (orig) => ({
  ...(await orig<typeof import('@capacitor/core')>()),
  Capacitor: { isNativePlatform: () => true, getPlatform: () => 'android' },
}));
vi.mock('./nexusNotificationsPlugin', () => ({
  NexusNotifications: {
    addListener: async (name: string, fn: Listener) => {
      plugin.listeners[name] = fn;
      return { remove: () => {} };
    },
    checkPermission: async () => ({ granted: true }),
    createChannel: async () => {},
    schedule: plugin.schedule,
    consumePendingTap: plugin.consumePendingTap,
    consumePendingAction: plugin.consumePendingAction,
    ackPendingTaps: plugin.ackPendingTaps,
    ackPendingActions: plugin.ackPendingActions,
  },
}));
vi.mock('../store/useSettingsStore', () => ({
  useSettingsStore: { getState: () => settings },
}));
vi.mock('../store/useTaskStore', () => ({ useTaskStore: { getState: () => ({ tasks: [] }) } }));

const { scheduleNotification, onNotificationTap, onNotificationAction, ID_RANGES } = await import('./notifications');
const { dueAtNotifTime } = await import('./taskReminders');

beforeEach(() => {
  plugin.listeners = {};
  plugin.schedule.mockClear();
  plugin.consumePendingTap.mockClear();
  plugin.consumePendingAction.mockClear();
  plugin.ackPendingTaps.mockClear();
  plugin.ackPendingActions.mockClear();
  settings.loaded = true;
  settings.notifMasterEnabled = true;
  settings.load.mockReset();
});

describe('dueAtNotifTime (NCC#142)', () => {
  const now = new Date(2026, 9, 13, 12, 0).getTime();

  it('fires a dated-and-timed task at its time', () => {
    const iso = new Date(2026, 9, 15, 0, 11).toISOString();
    expect(dueAtNotifTime(iso, now)?.getTime()).toBe(new Date(iso).getTime());
  });

  it('fires a date-only task at 09:00 local on that day', () => {
    expect(dueAtNotifTime('2026-10-15', now)?.getTime()).toBe(new Date(2026, 9, 15, 9, 0).getTime());
  });

  it('skips a past time and an unreadable value', () => {
    expect(dueAtNotifTime(new Date(2026, 9, 13, 11, 59).toISOString(), now)).toBeNull();
    expect(dueAtNotifTime('2026-10-13', now)).toBeNull();
    expect(dueAtNotifTime('not a date', now)).toBeNull();
  });
});

describe('the master switch (NCC#151)', () => {
  const at = new Date(Date.now() + 60_000);
  const base = { id: ID_RANGES.habits.base, category: 'habits' as const, title: 't', body: 'b', at };

  it('refuses to schedule anything while notifications are off', async () => {
    settings.notifMasterEnabled = false;
    const r = await scheduleNotification(base);
    expect(r.ok).toBe(false);
    expect(plugin.schedule).not.toHaveBeenCalled();
  });

  it('schedules when they are on, and passes a daily repeat through', async () => {
    const r = await scheduleNotification({ ...base, every: 'day' });
    expect(r.ok).toBe(true);
    expect(plugin.schedule).toHaveBeenCalledWith(expect.objectContaining({ every: 'day' }));
  });

  it('does not send a repeat the native side cannot honour', async () => {
    await scheduleNotification({ ...base, every: 'week' });
    expect(plugin.schedule.mock.calls[0][0]).not.toHaveProperty('every');
  });

  // Review B2: the switch defaults to off until settings load, and habits
  // load beside them (AppShell) or before them (behind the lock screen).
  it('loads settings before reading the switch when they are not loaded yet', async () => {
    settings.loaded = false;
    settings.notifMasterEnabled = false; // the default, before load()
    settings.load.mockImplementation(async () => {
      settings.loaded = true;
      settings.notifMasterEnabled = true; // what the user had saved
    });
    const r = await scheduleNotification(base);
    expect(settings.load).toHaveBeenCalledTimes(1);
    expect(r.ok).toBe(true);
    expect(plugin.schedule).toHaveBeenCalledTimes(1);
  });

  it('does not load settings again once they are loaded', async () => {
    await scheduleNotification(base);
    expect(settings.load).not.toHaveBeenCalled();
  });

  it('refuses rather than throws when settings cannot be read', async () => {
    settings.loaded = false;
    settings.load.mockRejectedValue(new Error('no storage'));
    const r = await scheduleNotification(base);
    expect(r.ok).toBe(false);
    expect(plugin.schedule).not.toHaveBeenCalled();
  });

  // Review N1: 02:30 on a spring-forward day is 03:30 by the clock, so `at`
  // alone cannot tell the native side which time of day to repeat.
  it('passes the wall-clock time of a daily repeat through', async () => {
    await scheduleNotification({ ...base, every: 'day', dailyTime: { hour: 2, minute: 30 } });
    expect(plugin.schedule).toHaveBeenCalledWith(
      expect.objectContaining({ every: 'day', hour: 2, minute: 30 }),
    );
  });

  // v1.18.1 (NCC#168): a weekly repeat is sent only with its weekday and time.
  it('passes a weekly repeat with its weekday and time through', async () => {
    await scheduleNotification({ ...base, every: 'week', weeklyTime: { weekday: 3, hour: 18, minute: 5 } });
    expect(plugin.schedule).toHaveBeenCalledWith(
      expect.objectContaining({ every: 'week', weekday: 3, hour: 18, minute: 5 }),
    );
  });

  it('sends no time of day for a one-shot', async () => {
    await scheduleNotification({ ...base, dailyTime: { hour: 2, minute: 30 } });
    const spec = plugin.schedule.mock.calls[0][0];
    expect(spec).not.toHaveProperty('hour');
    expect(spec).not.toHaveProperty('minute');
  });
});

describe('a notification delivered live is not replayed (NCC#143)', () => {
  // v1.18.1 (NCC#169): cleared by acknowledging its seq, not by draining.
  it('clears the tap from the queue after a live tap', async () => {
    const opened: string[] = [];
    await onNotificationTap((r) => opened.push(r));
    plugin.listeners.notificationTap({ route: '/tasks', seq: 143 });
    expect(opened).toEqual(['/tasks']);
    expect(plugin.ackPendingTaps).toHaveBeenCalledWith({ seqs: [143] });
  });

  it('clears the action from the queue after a live action', async () => {
    const seen: string[] = [];
    await onNotificationAction((a) => seen.push(a.actionId));
    plugin.listeners.notificationAction({ actionId: 'done', route: '/tasks', extraJson: '', seq: 144 });
    expect(seen).toEqual(['done']);
    await vi.waitFor(() => expect(plugin.ackPendingActions).toHaveBeenCalledWith({ seqs: [144] }));
  });
});
