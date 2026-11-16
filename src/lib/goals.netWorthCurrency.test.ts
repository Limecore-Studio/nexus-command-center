import { describe, it, expect, vi } from 'vitest';
import type { DataSources } from './goals';
import type { Goal } from '../types/goals';

vi.mock('./supabase', () => ({ supabase: {} }));

const { computeGoalProgress, formatGoalValue } = await import('./goals');

// v1.21.1 (NCC#255) — a net-worth goal compares and formats in its own
// currency, whatever the current base currency is.

// USD-anchored rates, as fxRates holds them: 1 USD = 0.9 EUR = 90 INR.
const RATES = { USD: 1, EUR: 0.9, INR: 90 };

const goal = (over: Partial<Goal> = {}): Goal => ({
  id: 'g1',
  title: 'Net worth',
  goalType: 'net_worth',
  targetValue: 50_000,
  startDate: '2026-01-01',
  currency: 'EUR',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  syncStatus: 'synced',
  completed: false,
  ...over,
} as Goal);

/** Net worth of exactly `amount` in `base`: one manual cash asset. */
const data = (amount: number, base: string, fxRates: Record<string, number> | null = RATES): DataSources => ({
  transactions: [],
  holdings: [],
  portfolioLots: [],
  stockQuotes: [],
  cryptoPrices: null,
  manualAssets: [{ id: 'a', name: 'Cash', assetType: 'cash', value: amount, currency: base }],
  tasks: [],
  workouts: [],
  studySessions: [],
  currentGpa: null,
  fxRates,
  baseCurrency: base,
} as unknown as DataSources);

describe('net-worth goal in its own currency', () => {
  it('base unchanged: compares as before', () => {
    const p = computeGoalProgress(goal(), data(25_000, 'EUR'));
    expect(p.currentValue).toBe(25_000);
    expect(p.percent).toBeCloseTo(50);
    expect(p.reached).toBe(false);
  });

  it('after a switch to INR, converts back to EUR instead of reading rupees as euros', () => {
    // 2,500,000 INR = 25,000 EUR at these rates.
    const p = computeGoalProgress(goal(), data(2_500_000, 'INR'));
    expect(p.currentValue).toBeCloseTo(25_000);
    expect(p.percent).toBeCloseTo(50);
    expect(p.reached).toBe(false);
  });

  it('formats with the goal currency, not the base', () => {
    expect(formatGoalValue(goal(), 25_000, 'INR')).toMatch(/€/);
  });

  it('no rate for the pair gives no reading rather than a wrong-currency one', () => {
    const p = computeGoalProgress(goal(), data(2_500_000, 'INR', null));
    expect(p.currentValue).toBe(0);
    expect(p.reached).toBe(false);
  });

  it('a goal with no stored currency follows the base, as before', () => {
    const p = computeGoalProgress(goal({ currency: undefined }), data(2_500_000, 'INR'));
    expect(p.currentValue).toBe(2_500_000);
  });
});
