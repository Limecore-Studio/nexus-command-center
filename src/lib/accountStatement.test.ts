import { describe, it, expect, vi } from 'vitest';

// The FX module reaches the supabase client, which needs a WebSocket that
// Node 20 (CI) does not have; these tests never touch it.
vi.mock('./supabase', () => ({ supabase: {} }));
vi.stubGlobal('window', { location: { origin: 'http://localhost' }, addEventListener() {}, removeEventListener() {} });
const { statementRunningBalances } = await import('./accountStatement');

// v1.18.1 (NCC#164) — a Deposit, Withdraw or Savings "Invest" shifts the
// account's undated opening balance, so the statement's rows dated before it
// read short by its amount. Each row now adds back the moves after it.

const acct = (sb: number, currency = 'EUR') => ({ id: 'a', currency, startingBalance: sb });
const row = (date: string, delta: number, createdAt = `${date}T12:00:00Z`) => ({ date, createdAt, delta });
const move = (id: string, type: 'deposit' | 'withdrawal', amount: number, createdAt: string, accountId = 'a', currency = 'EUR') =>
  ({ id, type, amount, currency, accountId, createdAt, syncStatus: 'synced' }) as any;

describe('account statement running balance (NCC#164)', () => {
  const rows = [row('2026-03-01', 1000), row('2026-06-01', -200), row('2026-09-01', 300)];

  it('with no moves, is the opening balance plus each delta', () => {
    expect(statementRunningBalances(acct(10000), rows, [], null)).toEqual([11000, 10800, 11100]);
  });

  it('a later deposit leaves every row where it was', () => {
    // 5 000 went into the portfolio in October: the opening fell to 5 000.
    const after = statementRunningBalances(acct(5000), rows, [move('d', 'deposit', 5000, '2026-10-12T10:00:00Z')], null);
    expect(after).toEqual([11000, 10800, 11100]);
  });

  it('a deposit between rows lowers only the rows after it, and the last row is the balance', () => {
    const b = statementRunningBalances(acct(5000), rows, [move('d', 'deposit', 5000, '2026-07-15T10:00:00Z')], null);
    // Before July: 10 000 opening. After July: 5 000 left in the account.
    expect(b).toEqual([11000, 10800, 6100]);
    expect(b[b.length - 1]).toBe(5000 + 1000 - 200 + 300);
  });

  it('a withdrawal (stored negative) is taken back off the rows before it', () => {
    // 2 000 came back from the portfolio in May: the opening rose to 12 000.
    const b = statementRunningBalances(acct(12000), rows, [move('w', 'withdrawal', -2000, '2026-05-10T10:00:00Z')], null);
    expect(b).toEqual([11000, 12800, 13100]);
  });

  it('on the same day, a move recorded after the row is added back to it', () => {
    const sameDay = [row('2026-06-01', -200, '2026-06-01T08:00:00Z'), row('2026-06-01', 100, '2026-06-01T14:00:00Z')];
    const b = statementRunningBalances(acct(5000), sameDay, [move('d', 'deposit', 5000, '2026-06-01T11:00:00Z')], null);
    expect(b).toEqual([9800, 4900]);
  });

  it("ignores other accounts' moves and buys/sells", () => {
    const b = statementRunningBalances(acct(10000), rows, [
      move('x', 'deposit', 5000, '2026-10-12T10:00:00Z', 'other'),
      { ...move('b', 'deposit', -700, '2026-10-12T10:00:00Z'), type: 'buy' },
    ], null);
    expect(b).toEqual([11000, 10800, 11100]);
  });

  it('converts a move in another currency into the account currency', () => {
    // Rates anchored to USD: 1 USD = 0.5 EUR. A 1 000 USD deposit took 500 EUR.
    const b = statementRunningBalances(acct(9500), rows, [move('d', 'deposit', 1000, '2026-10-12T10:00:00Z', 'a', 'USD')], { USD: 1, EUR: 0.5 });
    expect(b).toEqual([11000, 10800, 11100]);
  });
});
