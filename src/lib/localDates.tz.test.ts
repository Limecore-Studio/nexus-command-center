import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import process from 'node:process';

// v1.18.1 (NCC#145, NCC#148) — date-only values ("YYYY-MM-DD") were parsed
// with new Date(), which is UTC midnight, and read back in local time; and
// the creation day of a habit was the UTC day. Both only go wrong off UTC,
// so this file runs in New York time. (Vitest runs each file in its own
// process here, so the zone change stays in this file.)

// Some of these modules reach the supabase client, which needs a WebSocket
// that Node 20 (CI) does not have; none of the tests below touch it.
vi.mock('./supabase', () => ({ supabase: {} }));

const ORIGINAL_TZ = process.env.TZ;
let m: {
  parseDateLocal: typeof import('../utils/formatters').parseDateLocal;
  buildWeeklyReview: typeof import('./weeklyReview').buildWeeklyReview;
  startOfWeek: typeof import('./weeklyReview').startOfWeek;
  computeStreak: typeof import('./habitStreaks').computeStreak;
  dateKey: typeof import('./habitStreaks').dateKey;
  computeGoalProgress: typeof import('./goals').computeGoalProgress;
};

beforeAll(async () => {
  process.env.TZ = 'America/New_York';
  vi.stubGlobal('window', { location: { origin: 'http://localhost' }, addEventListener() {}, removeEventListener() {} });
  const f = await import('../utils/formatters');
  const w = await import('./weeklyReview');
  const h = await import('./habitStreaks');
  const g = await import('./goals');
  m = { parseDateLocal: f.parseDateLocal, buildWeeklyReview: w.buildWeeklyReview, startOfWeek: w.startOfWeek, computeStreak: h.computeStreak, dateKey: h.dateKey, computeGoalProgress: g.computeGoalProgress };
});
afterAll(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

describe('local dates west of UTC (NCC#145)', () => {
  it('runs in a zone behind UTC (guards the test itself)', () => {
    expect(new Date(2026, 9, 12).getTimezoneOffset()).toBeGreaterThan(0);
  });

  it('parseDateLocal reads a date-only value as local midnight, a timestamp as before', () => {
    const d = m.parseDateLocal('2026-10-12');
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()]).toEqual([2026, 9, 12, 0]);
    expect(m.parseDateLocal('2026-10-12T10:00:00Z').toISOString()).toBe('2026-10-12T10:00:00.000Z');
  });

  it('an expense dated this Monday counts in this week', () => {
    const ws = m.startOfWeek(new Date(2026, 9, 14, 12)); // Wed Oct 14 → Mon Oct 12
    const tx = (date: string, amount: number) => ({ id: date, amount, description: 'x', date, type: 'expense', syncStatus: 'synced', createdAt: '' });
    const r = m.buildWeeklyReview({
      weekStart: ws, transactions: [tx('2026-10-12', 100), tx('2026-10-11', 7)] as any,
      courses: [], sessions: [], workouts: [], tasks: [], currentGpa: null, holdings: [],
    } as any);
    expect(r.finance.spend).toBe(100);
    expect(r.finance.priorSpend).toBe(7);
  });

  it('a habit created and done this evening has a streak of 1', () => {
    const now = new Date(2026, 9, 12, 20, 5); // 00:05 UTC the next day
    const habit: any = { id: 'h', title: 'Read', type: 'binary', frequencyKind: 'daily', createdAt: new Date(2026, 9, 12, 20, 0).toISOString(), updatedAt: '', syncStatus: 'pending' };
    const comps: any[] = [{ id: 'c', habitId: 'h', date: m.dateKey(now), amount: 1 }];
    expect(m.computeStreak(habit, comps, now).current).toBe(1);
    const next = new Date(2026, 9, 13, 20, 5);
    comps.push({ id: 'c2', habitId: 'h', date: m.dateKey(next), amount: 1 });
    expect(m.computeStreak(habit, comps, next).current).toBe(2);
  });

  it('"days left" on a goal counts to the target day, not the day before', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 12, 9, 0));
    const base = { transactions: [], holdings: [], manualAssets: [], stockQuotes: {}, cryptoPrices: {}, fxRates: {}, baseCurrency: 'EUR', tasks: [], studySessions: [], workouts: [], currentGpa: null } as any;
    const goal: any = { id: 'g', title: 'x', goalType: 'manual', targetValue: 10, currentValue: 1, startDate: '2026-10-01', targetDate: '2026-10-22', completed: false, syncStatus: 'synced', createdAt: 'x' };
    const p: any = m.computeGoalProgress(goal, base);
    expect(p.daysRemaining).toBe(10);
    vi.useRealTimers();
  });
});

describe('date helpers used by tasks and lists (NCC#145 review)', () => {
  it('isToday / isOverdue read a due date as a local day', async () => {
    const { isToday, isOverdue, localDateKey } = await import('../utils/formatters');
    const today = localDateKey(new Date());
    expect(isToday(today)).toBe(true);
    expect(isOverdue(today)).toBe(false);
  });

  it('a date that does not exist is invalid rather than rolled over', () => {
    expect(Number.isNaN(m.parseDateLocal('2026-02-31').getTime())).toBe(true);
  });
});
