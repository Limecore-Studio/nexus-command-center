// v1.21 (NCC#230): base-currency change converts what is stored in it.
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
// See database.test.ts for why this seam is stubbed.
vi.mock('../lib/entitlement', () => ({ clearEntitlement: vi.fn() }));
import { db } from '../db/database';
import { applyCurrencyRebase, planCurrencyRebase, planSize } from './currencyRebase';
import type { BudgetCategory, Transaction } from '../types/finance';
import type { RecurringRule } from '../types/recurring';

// USD-based like the fx feed: 1 USD = 0.9 EUR = 81 INR → 1 EUR = 90 INR.
const RATES = { EUR: 0.9, INR: 81 };
const NOW = '2026-11-06T12:00:00.000Z';

const tx = (id: string, amount: number): Transaction => ({
  id, amount, description: id, date: '2026-11-01', type: 'expense', syncStatus: 'synced', createdAt: NOW,
});
const budget = (id: string, monthlyLimit: number, ownerId?: string): BudgetCategory => ({
  id, name: id, monthlyLimit, createdAt: NOW, ...(ownerId ? { ownerId } : {}),
});
const base = { every: 1, unit: 'month' as const, startDate: '2026-01-01', syncStatus: 'synced' as const, createdAt: NOW };
const rules: RecurringRule[] = [
  { ...base, id: 'r-tx', kind: 'transaction', template: { type: 'expense', amount: 12.5, description: 'Gym' } },
  { ...base, id: 'r-dep', kind: 'cash_deposit', template: { accountId: 'a1', amount: 100 } },
  { ...base, id: 'r-buy', kind: 'buy', template: { holdingId: 'h1', amount: 50, priceMode: 'market', currency: 'USD' } },
  { ...base, id: 'r-yield', kind: 'yield', template: { holdingId: 'h1', apyPct: 5, currency: 'EUR' } },
];

const plan = (over: Partial<Parameters<typeof planCurrencyRebase>[0]> = {}) =>
  planCurrencyRebase({
    from: 'EUR', to: 'INR', rates: RATES,
    transactions: [tx('t1', 1200), tx('t2', 0.333)],
    budgets: [budget('b-mine', 300), budget('b-own-pulled', 50, 'me'), budget('b-shared', 400, 'someone-else')],
    rules, userId: 'me', now: NOW, ...over,
  });

describe('planCurrencyRebase', () => {
  it('converts transactions at today\'s rate, rounded to the cent, and marks them pending', () => {
    const p = plan()!;
    expect(p.rate).toBeCloseTo(90, 10);
    expect(p.transactions.map((t) => [t.amount, t.syncStatus])).toEqual([[108000, 'pending'], [29.97, 'pending']]);
  });

  it('converts own budgets and leaves budgets shared by someone else alone', () => {
    const p = plan()!;
    expect(p.budgets.map((b) => [b.id, b.monthlyLimit])).toEqual([['b-mine', 27000], ['b-own-pulled', 4500]]);
    expect(p.sharedSkipped).toBe(1);
  });

  it('converts only base-currency recurring templates; buy and yield carry their own currency', () => {
    const p = plan()!;
    expect(p.rules.map((r) => r.id)).toEqual(['r-tx', 'r-dep']);
    const amounts = p.rules.map((r) => (r.template as { amount: number }).amount);
    expect(amounts).toEqual([1125, 9000]);
    expect(p.rules.every((r) => r.syncStatus === 'pending' && r.updatedAt === NOW)).toBe(true);
  });

  it('returns null with no rate for the pair, so nothing half-converts', () => {
    expect(plan({ rates: null })).toBeNull();
    expect(plan({ rates: { EUR: 0.9 } })).toBeNull();
  });

  it('does not mutate its input rows', () => {
    const t = tx('t1', 10);
    plan({ transactions: [t] });
    expect(t.amount).toBe(10);
  });

  it('planSize is zero for an empty ledger', () => {
    expect(planSize(plan({ transactions: [], budgets: [], rules: [] })!)).toBe(0);
  });
});

describe('applyCurrencyRebase', () => {
  beforeEach(async () => {
    await Promise.all([db.transactions.clear(), db.budgetCategories.clear(), db.recurringRules.clear(), db.syncQueue.clear()]);
  });

  it('writes every converted row and queues one update per row', async () => {
    const p = plan()!;
    await applyCurrencyRebase(p);
    expect((await db.transactions.get('t1'))?.amount).toBe(108000);
    expect((await db.budgetCategories.get('b-mine'))?.monthlyLimit).toBe(27000);
    expect(await db.budgetCategories.get('b-shared')).toBeUndefined();
    const q = await db.syncQueue.toArray();
    expect(q.map((i) => `${i.entityType}:${i.entityId}:${i.operation}`).sort()).toEqual([
      'budget_category:b-mine:update',
      'budget_category:b-own-pulled:update',
      'recurring_rule:r-dep:update',
      'recurring_rule:r-tx:update',
      'transaction:t1:update',
      'transaction:t2:update',
    ]);
    expect(JSON.parse(q.find((i) => i.entityId === 't1')!.payload).amount).toBe(108000);
  });
});
