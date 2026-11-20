import { describe, it, expect, vi } from 'vitest';
import type { DataSources } from './goals';
import type { Goal } from '../types/goals';

vi.mock('./supabase', () => ({ supabase: {} }));

const { computeGoalProgress } = await import('./goals');
const { netWorthParts } = await import('./netWorth');

// v1.22 (NCC#252) — the net-worth goal (and the Insights card and What-If)
// read accounts' opening balances and added liabilities. They now use the
// Finance overview's figure: derived balances, liabilities already negative,
// portfolio cash included.

const checking = { id: 'chk', name: 'Checking', accountType: 'checking', assetType: 'checking', startingBalance: 1000, value: 1000, currency: 'EUR' };
const card = { id: 'cc', name: 'Card', accountType: 'credit_card', assetType: 'credit_card', startingBalance: -2000, value: -2000, currency: 'EUR' };
const tx = (amount: number, type: 'income' | 'expense') => ({ id: `${type}-${amount}`, type, amount, accountId: 'chk', date: '2026-10-01', description: '', syncStatus: 'synced', createdAt: '' });

const sources = (over: Partial<DataSources> = {}): DataSources => ({
  transactions: [tx(4000, 'income'), tx(800, 'expense')],
  holdings: [],
  portfolioLots: [],
  stockQuotes: [],
  cryptoPrices: null,
  manualAssets: [checking, card],
  portfolioCashEntries: [{ id: 'c', type: 'deposit', amount: 500, currency: 'EUR', createdAt: '', syncStatus: 'synced' }],
  tasks: [],
  workouts: [],
  studySessions: [],
  currentGpa: null,
  fxRates: { USD: 1, EUR: 1 },
  baseCurrency: 'EUR',
  ...over,
} as unknown as DataSources);

describe('net worth (NCC#252)', () => {
  it('derived balances, debt subtracted, portfolio cash included', () => {
    // 1000 + 4000 − 800 = 4200 in checking, −2000 on the card, 500 in portfolio cash.
    expect(netWorthParts(sources()).total).toBe(2700);
  });

  it('the net-worth goal reads the same figure', () => {
    const goal = { id: 'g', title: 'NW', goalType: 'net_worth', targetValue: 5400, startDate: '2026-01-01', currency: 'EUR', completed: false, createdAt: '', updatedAt: '', syncStatus: 'synced' } as unknown as Goal;
    const p = computeGoalProgress(goal, sources());
    expect(p.currentValue).toBe(2700);
    expect(p.percent).toBeCloseTo(50);
  });
});
