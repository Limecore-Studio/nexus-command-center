import { describe, it, expect } from 'vitest';
import { buildWeeklyReview } from './weeklyReview';
import { buildWeeklyExtras } from './weeklyExtras';
import i18n from '../i18n';

// v1.22 (NCC#278) — the Weekly Review's suite view and its translated text.

const WEEK = new Date(2026, 10, 16); // Mon 16 Nov 2026
const base = { weekStart: WEEK, transactions: [], courses: [], sessions: [], workouts: [], tasks: [], currentGpa: null, holdings: [] } as any;
const xbase = { weekStart: WEEK, transactions: [], budgets: [], courses: [], sessions: [], workouts: [], habits: [], completions: [], rules: [] } as any;

describe('weekly review extras', () => {
  it('study hours per course, most first', () => {
    const r = buildWeeklyExtras({
      ...xbase,
      courses: [{ id: 'c1', name: 'Maths' }, { id: 'c2', name: 'Biology' }],
      sessions: [
        { id: 's1', subjectId: 'c1', startedAt: '2026-11-17T10:00:00', durationMinutes: 30 },
        { id: 's2', subjectId: 'c2', startedAt: '2026-11-18T10:00:00', durationMinutes: 90 },
        { id: 's3', subjectId: 'c1', startedAt: '2026-11-09T10:00:00', durationMinutes: 600 },
      ],
    });
    expect(r.studyByCourse).toEqual([
      { courseId: 'c2', name: 'Biology', minutes: 90 },
      { courseId: 'c1', name: 'Maths', minutes: 30 },
    ]);
  });

  it('a new best beats every earlier set; a first-time exercise is not one', () => {
    const set = (exercise: string, weightKg: number) => ({ exercise, weightKg, reps: 5 });
    const r = buildWeeklyExtras({
      ...xbase,
      workouts: [
        { id: 'w0', date: '2026-11-02', sets: [set('Bench', 80), set('Squat', 120)] },
        { id: 'w1', date: '2026-11-18', sets: [set('Bench', 82.5), set('Squat', 110), set('Row', 60)] },
      ],
    });
    expect(r.newBests).toEqual([{ exercise: 'Bench', weightKg: 82.5 }]);
  });

  it('bills recurring rules post in the seven days after the week; paused rules none', () => {
    const rule = (id: string, over: any = {}) => ({
      id, kind: 'transaction', every: 1, unit: 'month', anchorDay: 25, startDate: '2026-01-25',
      template: { type: 'expense', amount: 800, description: 'Rent' }, syncStatus: 'synced', createdAt: '', ...over,
    });
    const r = buildWeeklyExtras({
      ...xbase,
      rules: [rule('r1'), rule('r2', { pausedAt: '2026-11-01T00:00:00Z' }), rule('r3', { template: { type: 'income', amount: 1, description: 'Pay' } })],
    } as any);
    expect(r.billsNextWeek).toEqual([{ ruleId: 'r1', date: '2026-11-25', description: 'Rent', amount: 800 }]);
  });

  it('budget use follows the Life Score rule; no budgets means null', () => {
    const tx = (amount: number, categoryId?: string) => ({ id: `t${amount}`, type: 'expense', amount, categoryId, date: '2026-11-17' });
    const withBudget = buildWeeklyExtras({ ...xbase, transactions: [tx(150, 'g'), tx(900)], budgets: [{ id: 'g', name: 'Groceries', monthlyLimit: 300 }] } as any);
    expect(withBudget.budgetUsed).toBeCloseTo(0.5);
    expect(buildWeeklyExtras(xbase).budgetUsed).toBeNull();
  });

  it('insights and deltas follow the language', async () => {
    const fi = (await import('../i18n/locales/fi.json')).default;
    i18n.addResourceBundle('fi', i18n.options.defaultNS as string ?? 'translation', fi, true, true);
    await i18n.changeLanguage('fi');
    try {
      const r = buildWeeklyReview(base);
      expect(r.insights[0].text).toBe(fi.weeklyReview.ins.light);
    } finally {
      await i18n.changeLanguage('en');
    }
  });
});
