import { describe, it, expect, vi } from 'vitest';

// The FX module reaches the supabase client, which reads window at import.
vi.stubGlobal('window', { location: { origin: 'http://localhost' }, addEventListener() {}, removeEventListener() {} });
const { buildNetWorthTrend } = await import('./netWorthTrend');

// v1.18.1 (NCC#149) — a deposit into the portfolio lowers the account's
// undated opening balance and adds a dated cash entry, so every month before
// the deposit lost the amount: a flat 10 000 became 5 000 for past months.

const acct = (sb: number) => ({ id: 'a', name: 'Checking', accountType: 'checking', currency: 'EUR', startingBalance: sb, value: sb, createdAt: '2025-11-01T00:00:00Z', syncStatus: 'synced' });
const common = { transactions: [] as any[], snapshots: [] as any[], fxRates: null, baseCurrency: 'EUR', months: 4, today: '2026-10-12' };
const totals = (t: ReturnType<typeof buildNetWorthTrend>) => t.points.map((p) => p.total);

describe('net-worth trend across a move to or from the portfolio (NCC#149)', () => {
  it('a deposit leaves past months unchanged', () => {
    const before = buildNetWorthTrend({ ...common, accounts: [acct(10000)] as any, cashEntries: [] });
    const after = buildNetWorthTrend({
      ...common,
      accounts: [acct(5000)] as any,
      cashEntries: [{ id: 'c', type: 'deposit', amount: 5000, currency: 'EUR', accountId: 'a', createdAt: '2026-10-12T10:00:00Z', syncStatus: 'pending' }] as any,
    });
    expect(totals(before)).toEqual([10000, 10000, 10000, 10000]);
    expect(totals(after)).toEqual(totals(before));
  });

  it('a withdrawal leaves past months unchanged too', () => {
    const after = buildNetWorthTrend({
      ...common,
      accounts: [acct(12000)] as any,
      cashEntries: [
        { id: 'd', type: 'deposit', amount: 5000, currency: 'EUR', accountId: 'a', createdAt: '2026-08-01T10:00:00Z', syncStatus: 'synced' },
        { id: 'w', type: 'withdrawal', amount: -2000, currency: 'EUR', accountId: 'a', createdAt: '2026-10-05T10:00:00Z', syncStatus: 'synced' },
      ] as any,
    });
    // 15 000 before August's deposit, then 10 000 + 5 000 cash = 15 000 after
    // it, and still 15 000 after October's withdrawal.
    expect(totals(after)).toEqual([15000, 15000, 15000, 15000]);
  });
});
