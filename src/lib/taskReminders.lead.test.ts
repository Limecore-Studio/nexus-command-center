import { describe, it, expect, vi } from 'vitest';

// v1.19 — NCC#170: a task reminder fires the user's lead time before the
// due time, and says when the task is due.

vi.mock('./notifications', () => ({
  cancelCategory: async () => {}, cancelNotifications: async () => {}, scheduleNotification: async () => {},
  reminderEpoch: () => 0, ID_RANGES: { tasks: { base: 2000, size: 1000 } },
}));
vi.mock('../store/useTaskStore', () => ({ useTaskStore: { getState: () => ({ tasks: [] }) } }));
vi.mock('../store/useSettingsStore', () => ({ useSettingsStore: { getState: () => ({}) } }));

const { taskReminderTime, taskReminderWhen } = await import('./taskReminders');
const { formatLocale } = await import('../utils/formatters');
const i18n = (await import('../i18n')).default;
await i18n.changeLanguage('en');

const NOW = new Date(2026, 9, 22, 12, 0).getTime();
const at = (h: number, m = 0, day = 22) => new Date(2026, 9, day, h, m).getTime();

describe('taskReminderTime', () => {
  it('a timed task reminds the lead time before it is due', () => {
    const due = new Date(at(23, 59)).toISOString();
    expect(taskReminderTime(due, 60, NOW)?.at.getTime()).toBe(at(22, 59));
    expect(taskReminderTime(due, 15, NOW)?.at.getTime()).toBe(at(23, 44));
    expect(taskReminderTime(due, 0, NOW)?.at.getTime()).toBe(at(23, 59));
    expect(taskReminderTime(new Date(at(9, 0, 24)).toISOString(), 1440, NOW)?.at.getTime()).toBe(at(9, 0, 23));
  });

  it('when the lead moment has passed but the due time has not, at the due time', () => {
    const due = new Date(at(12, 30)).toISOString();
    expect(taskReminderTime(due, 60, NOW)?.at.getTime()).toBe(at(12, 30));
    expect(taskReminderTime(new Date(at(11, 0)).toISOString(), 60, NOW)).toBeNull();
  });

  it('a date-only task: 09:00 on the day, or 09:00 the day before with the one-day lead', () => {
    expect(taskReminderTime('2026-10-24', 60, NOW)?.at.getTime()).toBe(at(9, 0, 24));
    expect(taskReminderTime('2026-10-24', 1440, NOW)?.at.getTime()).toBe(at(9, 0, 23));
    // Tomorrow with a one-day lead: today 09:00 has passed, so tomorrow 09:00.
    expect(taskReminderTime('2026-10-23', 1440, NOW)?.at.getTime()).toBe(at(9, 0, 23));
    expect(taskReminderTime('2026-10-22', 0, NOW)).toBeNull();
  });
});

describe('taskReminderWhen', () => {
  // The time is formatted the way the app formats it (formatLocale).
  const time = (ms: number) => new Intl.DateTimeFormat(formatLocale(), { hour: '2-digit', minute: '2-digit' }).format(new Date(ms));
  it('says the due time, and "tomorrow" when the reminder fires the day before', () => {
    expect(taskReminderWhen(taskReminderTime(new Date(at(23, 59)).toISOString(), 60, NOW)!)).toBe(`Due at ${time(at(23, 59))}`);
    // Due tomorrow 14:00, one day ahead: reminds today 14:00.
    expect(taskReminderWhen(taskReminderTime(new Date(at(14, 0, 23)).toISOString(), 1440, NOW)!))
      .toBe(`Due tomorrow at ${time(at(14, 0, 23))}`);
    // Due tomorrow 08:30: today 08:30 has passed, so it reminds at 08:30
    // tomorrow, and from then it is "Due at".
    expect(taskReminderWhen(taskReminderTime(new Date(at(8, 30, 23)).toISOString(), 1440, NOW)!))
      .toBe(`Due at ${time(at(8, 30, 23))}`);
  });

  it('a date-only task: "Due today" or "Due tomorrow"', () => {
    expect(taskReminderWhen(taskReminderTime('2026-10-24', 60, NOW)!)).toBe('Due today');
    expect(taskReminderWhen(taskReminderTime('2026-10-24', 1440, NOW)!)).toBe('Due tomorrow');
  });
});
