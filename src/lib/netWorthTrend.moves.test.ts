import { describe, it, expect, vi } from 'vitest';

// The FX module reaches the supabase client, which needs a WebSocket that
// Node 20 (CI) does not have; these tests never touch it.
vi.mock('./supabase', () => ({ supabase: {} }));
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

// v1.18.1 (NCC#176) — a move in another currency was added back at today's
// rate, so the months before it drifted with the exchange rate. The entry now
// carries what the account was actually debited.
describe('net-worth trend across a cross-currency move (NCC#176)', () => {
  // 1 000 USD went into the portfolio in October, bought with 500 EUR on the
  // day. Today 1 USD = 0.8 EUR, so a re-conversion would add back 800.
  const fx = { USD: 1, EUR: 0.8 };
  const deposit = { id: 'c', type: 'deposit', amount: 1000, currency: 'USD', accountId: 'a', createdAt: '2026-10-12T10:00:00Z', syncStatus: 'pending' };

  it('adds back the amount the account was debited, not today\'s conversion', () => {
    const t = buildNetWorthTrend({
      ...common,
      fxRates: fx,
      accounts: [acct(9500)] as any,
      cashEntries: [{ ...deposit, accountAmount: 500, accountCurrency: 'EUR' }] as any,
    });
    expect(t.points.slice(0, 3).map((p) => p.accountsBase)).toEqual([10000, 10000, 10000]);
  });

  it('falls back to today\'s rate for an entry made before the amount was stored', () => {
    const t = buildNetWorthTrend({ ...common, fxRates: fx, accounts: [acct(9500)] as any, cashEntries: [deposit] as any });
    expect(t.points[0].accountsBase).toBe(10300);
  });

  it('adds back in the account currency, then converts with the rest of the balance', () => {
    // A SEK account (1 EUR = 10 SEK today) debited 5 000 SEK for a 500 EUR deposit.
    const sek = { ...acct(45000), currency: 'SEK' };
    const t = buildNetWorthTrend({
      ...common,
      fxRates: { EUR: 1, SEK: 10 },
      accounts: [sek] as any,
      cashEntries: [{ ...deposit, amount: 500, currency: 'EUR', accountAmount: 5000, accountCurrency: 'SEK' }] as any,
    });
    expect(t.points[0].accountsBase).toBe(5000);
  });
});
