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
}));
const settings = vi.hoisted(() => ({ notifMasterEnabled: true }));

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
    schedule: plugin.schedule,
    consumePendingTap: plugin.consumePendingTap,
    consumePendingAction: plugin.consumePendingAction,
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
  settings.notifMasterEnabled = true;
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
});

describe('a notification delivered live is not replayed (NCC#143)', () => {
  it('clears the tap buffer after a live tap', async () => {
    const opened: string[] = [];
    await onNotificationTap((r) => opened.push(r));
    plugin.consumePendingTap.mockClear(); // the cold-start drain
    plugin.listeners.notificationTap({ route: '/tasks' });
    expect(opened).toEqual(['/tasks']);
    expect(plugin.consumePendingTap).toHaveBeenCalledTimes(1);
  });

  it('clears the action buffer after a live action', async () => {
    const seen: string[] = [];
    await onNotificationAction((a) => seen.push(a.actionId));
    plugin.consumePendingAction.mockClear();
    plugin.listeners.notificationAction({ actionId: 'done', route: '/tasks', extraJson: '' });
    expect(seen).toEqual(['done']);
    expect(plugin.consumePendingAction).toHaveBeenCalledTimes(1);
  });
});
