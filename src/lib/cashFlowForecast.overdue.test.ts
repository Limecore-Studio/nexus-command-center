import { describe, it, expect, vi } from 'vitest';

vi.stubGlobal('window', { location: { origin: 'http://localhost' }, addEventListener() {}, removeEventListener() {} });
const { detectRecurring, projectCashFlow } = await import('./cashFlowForecast');

// v1.18.1 (NCC#150) — the projection started at nextExpected even when that
// date had passed, so a late item counted twice, and a cancelled one was
// projected for ever.

const NOW = Date.parse('2026-10-12T12:00:00Z');
const rent = (date: string) => ({ id: date, amount: 1000, description: 'Rent', date, type: 'expense', categoryId: 'rent', syncStatus: 'synced', createdAt: '' });

describe('cash-flow forecast with late or ended items (NCC#150)', () => {
  it('a monthly item that is a few days late counts once in 30 days', () => {
    const rec = detectRecurring([rent('2026-08-08'), rent('2026-09-08')] as any, 'EUR', new Map([['rent', 'Rent']]), NOW);
    expect(rec).toHaveLength(1);
    expect(projectCashFlow(rec, 30, 'EUR', NOW).projectedExpenses).toBe(1000);
  });

  it('an item more than one interval overdue is treated as ended', () => {
    const rec = detectRecurring([rent('2026-06-08'), rent('2026-07-08')] as any, 'EUR', new Map([['rent', 'Rent']]), NOW);
    const p = projectCashFlow(rec, 30, 'EUR', NOW);
    expect(p.projectedExpenses).toBe(0);
    expect(p.recurringItems).toEqual([]);
  });

  it('an item that is on time is projected as before', () => {
    const rec = detectRecurring([rent('2026-09-15'), rent('2026-10-10')] as any, 'EUR', new Map([['rent', 'Rent']]), NOW);
    const p = projectCashFlow(rec, 60, 'EUR', NOW);
    expect(p.projectedExpenses).toBe(2000);
  });
});

describe('the listed next date (NCC#150 review)', () => {
  it('is the occurrence the projection counts from, not the missed one', () => {
    const rec = detectRecurring([rent('2026-08-08'), rent('2026-09-08')] as any, 'EUR', new Map([['rent', 'Rent']]), NOW);
    const p = projectCashFlow(rec, 30, 'EUR', NOW);
    expect(Date.parse(p.recurringItems[0].nextExpected)).toBeGreaterThan(NOW);
  });
});
