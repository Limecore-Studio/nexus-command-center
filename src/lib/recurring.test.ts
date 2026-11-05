import { describe, it, expect, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';

vi.mock('./supabase', () => ({ supabase: {} }));

// v1.19 — NCC#202: recurring rules. The pure engine (dates, ids), the
// materialiser against real Dexie (fake-indexeddb), and the forecast.

const { occurrenceAt, occurrencesBetween, nextOccurrence, uuidv5, occurrenceId } = await import('./recurring');
const { materializeDue } = await import('./recurringMaterialize');
const { detectRecurring, projectCashFlow } = await import('./cashFlowForecast');
const { db } = await import('../db/database');
type Rule = import('../types/recurring').RecurringRule;
type Deps = import('./recurringMaterialize').MaterializeDeps;

const rule = (over: Partial<Rule> & Pick<Rule, 'kind' | 'template'>): Rule =>
  ({
    id: '11111111-2222-4333-8444-555555555555',
    every: 1,
    unit: 'month',
    startDate: '2026-01-31',
    syncStatus: 'synced',
    createdAt: '2026-01-01T00:00:00Z',
    ...over,
  }) as Rule;

const deps = (over: Partial<Deps> = {}): Deps => ({
  today: '2026-10-22',
  baseCurrency: 'EUR',
  unitPrice: () => ({ price: 100, currency: 'USD' }),
  convert: (a, from, to) => (from === to ? a : from === 'EUR' && to === 'USD' ? a * 1.1 : null),
  depositLabel: 'Portfolio deposit',
  ...over,
});

const expense = (over: Partial<Rule> = {}): Rule =>
  ({ ...rule({ kind: 'transaction', template: { type: 'expense', amount: 50, description: 'Gym', accountId: 'acc-1' } }), ...over }) as Rule;

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
});

describe('occurrence dates', () => {
  it('clamps a month-end anchor to short months and returns to the 31st', () => {
    const r = { startDate: '2026-01-31', every: 1, unit: 'month' as const, anchorDay: 31 };
    expect([0, 1, 2, 3].map((k) => occurrenceAt(r, k))).toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
    expect(occurrenceAt({ ...r, startDate: '2028-01-31' }, 1)).toBe('2028-02-29'); // leap year
  });

  it('steps days and weeks by the calendar, every n', () => {
    expect(occurrencesBetween({ startDate: '2026-03-27', every: 2, unit: 'day' }, undefined, '2026-04-02'))
      .toEqual(['2026-03-27', '2026-03-29', '2026-03-31', '2026-04-02']); // across the EU DST change
    expect(occurrencesBetween({ startDate: '2026-10-05', every: 1, unit: 'week' }, '2026-10-05', '2026-10-26'))
      .toEqual(['2026-10-12', '2026-10-19', '2026-10-26']);
  });

  it('stops at the end date and reports no next occurrence after it', () => {
    const r = { startDate: '2026-01-15', endDate: '2026-03-15', every: 1, unit: 'month' as const };
    expect(occurrencesBetween(r, undefined, '2026-12-31')).toEqual(['2026-01-15', '2026-02-15', '2026-03-15']);
    expect(nextOccurrence(r, '2026-03-15')).toBeUndefined();
    expect(nextOccurrence(r, '2026-01-20')).toBe('2026-02-15');
  });
});

describe('deterministic ids', () => {
  it('uuidv5 matches the RFC 4122 reference vector', async () => {
    expect(await uuidv5('www.example.com', '6ba7b810-9dad-11d1-80b4-00c04fd430c8')).toBe('2ed6657d-e927-568b-95e1-2665a8aea6a2');
  });

  it('is a pure function of rule, date and part', async () => {
    const a = await occurrenceId('r1', '2026-10-01', 'tx');
    expect(await occurrenceId('r1', '2026-10-01', 'tx')).toBe(a);
    expect(await occurrenceId('r1', '2026-10-01', 'cash')).not.toBe(a);
    expect(await occurrenceId('r1', '2026-10-02', 'tx')).not.toBe(a);
  });
});

describe('materialising', () => {
  it('writes each due occurrence once; a second run and a second device add nothing', async () => {
    await db.recurringRules.put(expense({ startDate: '2026-08-31', anchorDay: 31 }));
    const first = await materializeDue(deps());
    expect(first.created).toBe(2); // Aug 31, Sep 30 (Oct 31 is not due yet)
    const rows = await db.transactions.orderBy('date').toArray();
    expect(rows.map((r) => r.date)).toEqual(['2026-08-31', '2026-09-30']);
    expect(rows.every((r) => r.recurringRuleId === expense().id && r.syncStatus === 'pending')).toBe(true);

    expect((await materializeDue(deps())).created).toBe(0);
    // Another device that never saw the progress: same ids, so no new rows.
    await db.recurringRules.update(expense().id, { lastMaterializedDate: undefined });
    expect((await materializeDue(deps())).created).toBe(0);
    expect(await db.transactions.count()).toBe(2);
  });

  it('catches up after 40 missed days and records progress (queued once per run)', async () => {
    await db.recurringRules.put(expense({ unit: 'day', startDate: '2026-09-13', lastMaterializedDate: '2026-09-12' }));
    const res = await materializeDue(deps());
    expect(res.created).toBe(40); // Sep 13 .. Oct 22
    const r = await db.recurringRules.get(expense().id);
    expect(r?.lastMaterializedDate).toBe('2026-10-22');
    const ruleItems = await db.syncQueue.filter((q) => q.entityType === 'recurring_rule').toArray();
    expect(ruleItems).toHaveLength(1);
    expect(JSON.parse(ruleItems[0].payload).lastMaterializedDate).toBe('2026-10-22');
  });

  it('skips paused rules', async () => {
    await db.recurringRules.put(expense({ pausedAt: '2026-09-01T00:00:00Z' }));
    expect((await materializeDue(deps())).created).toBe(0);
  });

  it('a portfolio deposit is a transfer out of the account plus a cash deposit with no accountId', async () => {
    await db.recurringRules.put(
      rule({ kind: 'cash_deposit', template: { accountId: 'acc-1', amount: 200 }, startDate: '2026-10-01', unit: 'month' }),
    );
    await materializeDue(deps());
    const [tx] = await db.transactions.toArray();
    const [cash] = await db.portfolioCashEntries.toArray();
    expect(tx).toMatchObject({ type: 'transfer', amount: 200, accountId: 'acc-1', description: 'Portfolio deposit', date: '2026-10-01' });
    expect(tx.destinationAccountId).toBeUndefined();
    expect(cash).toMatchObject({ type: 'deposit', amount: 200, currency: 'EUR', relatedId: tx.id });
    expect(cash.accountId).toBeUndefined();
  });

  it('a market-price buy waits with no price, then uses the loaded price', async () => {
    await db.portfolioHoldings.put({ id: 'h1', ticker: 'VT', name: 'VT', assetType: 'etf', quantity: 0, createdAt: '' });
    await db.recurringRules.put(
      rule({ kind: 'buy', template: { holdingId: 'h1', amount: 110, priceMode: 'market', currency: 'EUR' }, startDate: '2026-10-01' }),
    );
    const waiting = await materializeDue(deps({ unitPrice: () => null }));
    expect(waiting.created).toBe(0);
    let r = await db.recurringRules.get(expense().id);
    expect(r?.waitingSince).toBe('2026-10-01');
    expect(r?.lastMaterializedDate).toBeUndefined();
    expect(await db.syncQueue.count()).toBe(0); // the flag is local-only

    const res = await materializeDue(deps());
    expect(res.touchedHoldings).toEqual(['h1']);
    const [lot] = await db.portfolioLots.toArray();
    // 110 EUR → 121 USD at 1.1, at 100 USD a unit.
    expect(lot).toMatchObject({ holdingId: 'h1', costPerUnit: 100, costCurrency: 'USD', purchaseDate: '2026-10-01' });
    expect(lot.quantity).toBeCloseTo(1.21);
    const [cash] = await db.portfolioCashEntries.toArray();
    expect(cash).toMatchObject({ type: 'buy', currency: 'USD', relatedId: lot.id });
    expect(cash.amount).toBeCloseTo(-121);
    r = await db.recurringRules.get(expense().id);
    expect(r?.waitingSince).toBeUndefined();
  });

  it('a fixed-price buy of a fixed quantity needs no price at all', async () => {
    await db.portfolioHoldings.put({ id: 'h1', ticker: 'VT', name: 'VT', assetType: 'etf', quantity: 0, createdAt: '' });
    await db.recurringRules.put(
      rule({ kind: 'buy', template: { holdingId: 'h1', quantity: 2, priceMode: 'fixed', price: 50, currency: 'EUR' }, startDate: '2026-10-01' }),
    );
    await materializeDue(deps({ unitPrice: () => null }));
    const [lot] = await db.portfolioLots.toArray();
    expect(lot).toMatchObject({ quantity: 2, costPerUnit: 50, costCurrency: 'EUR' });
  });
});

describe('forecast', () => {
  const NOW = new Date(2026, 9, 22, 12).getTime();
  it('does not count a rule twice: its rows are not detected, its future dates are projected once', () => {
    const r = expense({ startDate: '2026-07-22', unit: 'month', anchorDay: 22, lastMaterializedDate: '2026-10-22' });
    const txs = ['2026-07-22', '2026-08-22', '2026-09-22', '2026-10-22'].map((date, i) => ({
      id: `t${i}`, type: 'expense' as const, amount: 50, description: 'Gym', date, recurringRuleId: r.id,
      syncStatus: 'synced' as const, createdAt: '',
    }));
    expect(detectRecurring(txs, 'EUR', new Map(), NOW)).toEqual([]);
    // 60 days from Oct 22 runs to Dec 21: Nov 22 only. Oct 22 is a real row
    // already (and the 30-day window, to Nov 21, holds none).
    expect(projectCashFlow([], 30, 'EUR', NOW, [r]).projectedExpenses).toBe(0);
    const p = projectCashFlow([], 60, 'EUR', NOW, [r]);
    expect(p.projectedExpenses).toBe(50);
    expect(p.recurringItems[0]).toMatchObject({ key: `rule:${r.id}`, nextExpected: '2026-11-22', rule: { every: 1, unit: 'month' } });
  });

  it('leaves deposits, transfers and paused rules out', () => {
    const rules = [
      rule({ kind: 'cash_deposit', template: { accountId: 'a', amount: 100 } }),
      expense({ pausedAt: '2026-10-01T00:00:00Z' }),
      rule({ kind: 'transaction', template: { type: 'transfer', amount: 10, description: 'x', accountId: 'a', destinationAccountId: 'b' } }),
    ];
    const p = projectCashFlow([], 60, 'EUR', NOW, rules);
    expect(p.projectedExpenses + p.projectedIncome).toBe(0);
  });
});

// v1.20 (NCC#203) — staking yield: one cost-0 lot per month, compounding,
// worked out from scratch each run so two devices write the same number.
describe('staking yield', () => {
  const H = 'h-sol';
  const holding = { id: H, assetType: 'crypto', ticker: 'SOL', quantity: 10, costCurrency: 'EUR', syncStatus: 'synced', createdAt: '2026-01-01T00:00:00Z' };
  const bought = { id: 'lot-buy', holdingId: H, quantity: 10, costPerUnit: 100, costCurrency: 'EUR', purchaseDate: '2026-09-15', syncStatus: 'synced', createdAt: '2026-09-15T00:00:00Z' };
  const yieldRule = (over: Partial<Rule> = {}) =>
    rule({ kind: 'yield', template: { holdingId: H, apyPct: 10, currency: 'EUR' }, every: 1, unit: 'day', startDate: '2026-10-01', ...over } as any);
  const r = Math.pow(1.1, 1 / 365) - 1;
  const grown = (units: number, days: number) => units * (Math.pow(1 + r, days) - 1);

  beforeEach(async () => {
    await db.portfolioHoldings.put(holding as any);
    await db.portfolioLots.put(bought as any);
  });

  it('accrues the month into one cost-0 lot, compounding daily', async () => {
    await db.recurringRules.put(yieldRule());
    await materializeDue(deps({ today: '2026-10-10' }));
    const lot = await db.portfolioLots.get(await occurrenceId(yieldRule().id, '2026-10', 'lot'));
    expect(lot).toMatchObject({ holdingId: H, costPerUnit: 0, costCurrency: 'EUR', purchaseDate: '2026-10-10', recurringRuleId: yieldRule().id });
    expect(lot!.quantity).toBeCloseTo(grown(10, 10), 12);
    expect(await db.portfolioLots.count()).toBe(2);
    expect((await db.syncQueue.toArray()).filter((q) => q.entityType === 'portfolio_lot')).toHaveLength(1);
  });

  it('a later day brings the same lot up to date; a rerun the same day writes nothing', async () => {
    await db.recurringRules.put(yieldRule());
    await materializeDue(deps({ today: '2026-10-10' }));
    await materializeDue(deps({ today: '2026-10-10' }));
    expect(await db.syncQueue.count()).toBe(2); // the lot insert + the rule's progress
    await materializeDue(deps({ today: '2026-10-12' }));
    const lot = await db.portfolioLots.get(await occurrenceId(yieldRule().id, '2026-10', 'lot'));
    expect(lot!.quantity).toBeCloseTo(grown(10, 12), 12);
    const lotWrites = (await db.syncQueue.toArray())
      .filter((q) => q.entityType === 'portfolio_lot')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    expect(lotWrites.map((q) => q.operation)).toEqual(['insert', 'update']);
  });

  it('a new month opens a new lot, and last month\'s rewards earn too', async () => {
    await db.recurringRules.put(yieldRule());
    await materializeDue(deps({ today: '2026-11-02' }));
    const oct = await db.portfolioLots.get(await occurrenceId(yieldRule().id, '2026-10', 'lot'));
    const nov = await db.portfolioLots.get(await occurrenceId(yieldRule().id, '2026-11', 'lot'));
    expect(oct!.quantity).toBeCloseTo(grown(10, 31), 12);
    expect(nov!.quantity).toBeCloseTo(grown(10 + oct!.quantity, 2), 12);
    // October is over: a later run leaves its lot alone.
    await materializeDue(deps({ today: '2026-11-05' }));
    expect((await db.portfolioLots.get(oct!.id))!.quantity).toBe(oct!.quantity);
  });

  it('another device that already wrote the same days is matched, not added to', async () => {
    await db.recurringRules.put(yieldRule());
    const id = await occurrenceId(yieldRule().id, '2026-10', 'lot');
    await db.portfolioLots.put({ id, holdingId: H, quantity: grown(10, 10), costPerUnit: 0, costCurrency: 'EUR', purchaseDate: '2026-10-10', recurringRuleId: yieldRule().id, syncStatus: 'synced', createdAt: 'x' } as any);
    await materializeDue(deps({ today: '2026-10-10' }));
    expect((await db.syncQueue.toArray()).filter((q) => q.entityType === 'portfolio_lot')).toEqual([]);
    expect((await db.portfolioLots.get(id))!.quantity).toBeCloseTo(grown(10, 10), 12);
  });

  it('nothing accrues on units not yet held, and it waits for a missing holding', async () => {
    await db.recurringRules.put(yieldRule({ startDate: '2026-09-10' } as any));
    await materializeDue(deps({ today: '2026-09-15' }));
    // Bought on the 15th: held from the 16th, so nothing for 10–15 September.
    expect(await db.portfolioLots.count()).toBe(1);
    await db.portfolioHoldings.clear();
    const res = await materializeDue(deps({ today: '2026-09-20' }));
    expect(res.created).toBe(0);
    // A catch-up tries each month once, on its last due day (see materializeDue).
    expect((await db.recurringRules.toArray())[0].waitingSince).toBe('2026-09-20');
  });

  it('a holding with no recorded purchases waits, so its typed quantity is never replaced', async () => {
    await db.portfolioLots.clear();
    await db.recurringRules.put(yieldRule());
    const res = await materializeDue(deps({ today: '2026-10-10' }));
    expect(res).toEqual({ created: 0, touchedHoldings: [] });
    expect(await db.portfolioLots.count()).toBe(0);
    expect((await db.recurringRules.toArray())[0].waitingSince).toBe('2026-10-10');
  });

  it('the template carries no amount or quantity, so NCC 1.19 (which reads it as a buy) waits instead of buying', () => {
    const t = yieldRule().template as unknown as Record<string, unknown>;
    expect(Object.keys(t).sort()).toEqual(['apyPct', 'currency', 'holdingId']);
  });
});
