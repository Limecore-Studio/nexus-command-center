import { describe, it, expect, beforeEach, vi } from 'vitest';

// v1.22 (NCC#258) — task reminder, budget and watchlist alert ids are
// assigned per device instead of hashed, so two rows never share an alarm.

const prefs = vi.hoisted(() => new Map<string, string>());
vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: async ({ key }: { key: string }) => ({ value: prefs.get(key) ?? null }),
    set: async ({ key, value }: { key: string; value: string }) => void prefs.set(key, value),
  },
}));

const notif = vi.hoisted(() => ({ scheduled: [] as number[], cancelled: [] as number[] }));
vi.mock('./notifications', () => ({
  ID_RANGES: { tasks: { base: 2000, size: 1000 } },
  scheduleNotification: async (spec: { id: number }) => void notif.scheduled.push(spec.id),
  cancelNotifications: async (ids: number[]) => void notif.cancelled.push(...ids),
  cancelCategory: async () => {},
  reminderEpoch: () => 0,
}));
vi.mock('../store/useSettingsStore', () => ({
  useSettingsStore: { getState: () => ({ notifMasterEnabled: true, notifTasksEnabled: true, taskReminderLeadMin: 0 }) },
}));
vi.mock('../store/useTaskStore', () => ({ useTaskStore: { getState: () => ({ tasks: [] }) } }));

const { slotAllocator, hashSlot } = await import('./notifSlots');
const { scheduleTaskReminder, cancelTaskReminder } = await import('./taskReminders');

/** Two ids whose hash lands in the same slot of `size`. */
function collidingPair(size: number): [string, string] {
  const seen = new Map<number, string>();
  for (let i = 0; ; i++) {
    const id = `task-${i}`;
    const s = hashSlot(id, size);
    const other = seen.get(s);
    if (other) return [other, id];
    seen.set(s, id);
  }
}

beforeEach(() => {
  notif.scheduled.length = 0;
  notif.cancelled.length = 0;
});

describe('slotAllocator', () => {
  beforeEach(() => prefs.clear());

  it('gives two rows with the same hash different slots, keeps the first on its hash slot', async () => {
    const [a, b] = collidingPair(10);
    const slots = slotAllocator('t.slots', 10);
    expect(await slots.slotOf(a)).toBe(hashSlot(a, 10));
    const sb = await slots.slotOf(b);
    expect(sb).not.toBe(hashSlot(a, 10));
    expect(await slots.slotOf(a)).toBe(hashSlot(a, 10));
  });

  it('remembers across runs, frees, resets, and is null when full', async () => {
    const one = slotAllocator('t2.slots', 2);
    const s = await one.slotOf('x');
    expect(await slotAllocator('t2.slots', 2).peek('x')).toBe(s);
    await one.slotOf('y');
    expect(await one.slotOf('z')).toBeNull();
    await one.free('y');
    expect(await one.slotOf('z')).not.toBeNull();
    await one.reset();
    expect(await one.peek('x')).toBeUndefined();
  });
});

describe('task reminders (NCC#258)', () => {
  it('two tasks whose old hash ids collided get two alarms; cancelling one leaves the other', async () => {
    const [a, b] = collidingPair(1000);
    const due = new Date(Date.now() + 86_400_000).toISOString();
    const task = (id: string) => ({ id, title: id, dueDate: due, completed: false, priority: 'medium' }) as any;
    await scheduleTaskReminder(task(a));
    await scheduleTaskReminder(task(b));
    expect(new Set(notif.scheduled).size).toBe(2);
    await cancelTaskReminder(a);
    expect(notif.cancelled).toEqual([notif.scheduled[0]]);
  });

  it('cancelling a task that never had a reminder cancels nothing', async () => {
    await cancelTaskReminder('never-scheduled');
    expect(notif.cancelled).toEqual([]);
  });
});
