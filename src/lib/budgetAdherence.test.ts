import { describe, it, expect } from 'vitest';
import { buildCrossDomainReport } from './crossDomainSignals';

// v1.22 (NCC#253) — budget adherence compares like with like: spending in
// this user's limited categories against those limits.

const TODAY = new Date(2026, 10, 19); // Thu 19 Nov 2026
const tx = (id: string, amount: number, categoryId?: string) =>
  ({ id, type: 'expense', amount, categoryId, date: '2026-11-03', description: '', syncStatus: 'synced', createdAt: '' }) as any;
const budget = (id: string, monthlyLimit: number, ownerId?: string) => ({ id, name: id, monthlyLimit, ownerId, createdAt: '' }) as any;

const adherence = (txns: any[], budgets: any[], userId?: string) => {
  const r = buildCrossDomainReport([], [], txns, budgets, [], [], 8, TODAY, { userId });
  return r.weeks.finance.find((w) => w.weekStart === '2026-11-16')!.budgetAdherence;
};

describe('budget adherence (NCC#253)', () => {
  it('unbudgeted spending does not count against the one budget there is', () => {
    const a = adherence([tx('g', 250, 'groceries'), tx('rent', 900), tx('misc', 50, 'nolimit')], [budget('groceries', 300), budget('nolimit', 0)]);
    expect(a).toBeCloseTo(250 / 300);
  });

  it("a budget shared by someone else is left out", () => {
    const a = adherence([tx('g', 300, 'groceries'), tx('s', 500, 'shared')], [budget('groceries', 300, 'me'), budget('shared', 100, 'them')], 'me');
    expect(a).toBeCloseTo(1);
  });

  it('no limited budget means no adherence', () => {
    expect(adherence([tx('rent', 900)], [budget('nolimit', 0)])).toBeNull();
  });
});
