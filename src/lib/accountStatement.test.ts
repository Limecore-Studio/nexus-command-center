import { describe, it, expect, vi } from 'vitest';

// The FX module reaches the supabase client, which needs a WebSocket that
// Node 20 (CI) does not have; these tests never touch it.
vi.mock('./supabase', () => ({ supabase: {} }));
vi.stubGlobal('window', { location: { origin: 'http://localhost' }, addEventListener() {}, removeEventListener() {} });
const { compareStatementRows, portfolioMoveRows, statementOpening, statementRunningBalances } = await import('./accountStatement');
type StatementRow = import('./accountStatement').StatementRow;
const last = <T,>(xs: T[]): T => xs[xs.length - 1];

// v1.18.1 (NCC#164, NCC#176) — a Deposit, Withdraw or Savings "Invest" shifts
// the account's undated opening balance. The statement shows each move as a
// row of its own and walks from the opening as it was before any move, so
// every row is the balance on its date and the newest row is the balance.

type Acct = { id: string; currency: string; startingBalance: number };
const acct = (sb: number, currency = 'EUR'): Acct => ({ id: 'a', currency, startingBalance: sb });
// Timestamps are built in LOCAL time, so a row or move stays on the day it
// names in every zone (UTC+14 to UTC-12), as it does on the user's phone.
const at = (date: string, hour = 12): string => {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d, hour).toISOString();
};
const row = (date: string, delta: number, createdAt = at(date)): StatementRow => ({ date, createdAt, delta });
const move = (id: string, type: 'deposit' | 'withdrawal', amount: number, createdAt: string, accountId = 'a', currency = 'EUR', extra: object = {}) =>
  ({ id, type, amount, currency, accountId, createdAt, syncStatus: 'synced', ...extra }) as any;

/** What AccountDetail does: transactions + this account's moves, sorted, walked. */
function statement(a: Acct, txns: StatementRow[], cash: any[], fx: Record<string, number> | null = null) {
  const moves = portfolioMoveRows(a, cash, fx);
  const rows = [...txns, ...moves.rows].sort(compareStatementRows);
  return {
    rows,
    unconvertible: moves.unconvertible,
    deltas: rows.map((r) => (r.move ? `move ${r.delta}` : r.delta)),
    balances: statementRunningBalances(a.startingBalance, rows),
    opening: statementOpening(a.startingBalance, rows),
  };
}
const currentBalance = (a: Acct, txns: StatementRow[]) => txns.reduce((s, r) => s + r.delta, a.startingBalance);

describe('account statement with portfolio moves as rows (NCC#176)', () => {
  const rows = [row('2026-03-01', 1000), row('2026-06-01', -200), row('2026-09-01', 300)];

  it('with no moves, is the opening balance plus each delta', () => {
    const s = statement(acct(10000), rows, []);
    expect(s.balances).toEqual([11000, 10800, 11100]);
    expect(s.opening).toBe(10000);
  });

  it('a deposit after the newest transaction is the top row, and equals the header balance', () => {
    // 5 000 went into the portfolio in October: the opening fell to 5 000.
    const a = acct(5000);
    const s = statement(a, rows, [move('d', 'deposit', 5000, at('2026-10-12', 10))]);
    expect(s.deltas).toEqual([1000, -200, 300, 'move -5000']);
    expect(s.balances).toEqual([11000, 10800, 11100, 6100]);
    expect(last(s.balances)).toBe(currentBalance(a, rows));
    // "Opened" is the opening before the move, so Opened + Net change = balance.
    expect(s.opening).toBe(10000);
  });

  it('a deposit between rows sits between them and lowers only the rows after it', () => {
    const s = statement(acct(5000), rows, [move('d', 'deposit', 5000, at('2026-07-15', 10))]);
    expect(s.deltas).toEqual([1000, -200, 'move -5000', 300]);
    expect(s.balances).toEqual([11000, 10800, 5800, 6100]);
  });

  it('a withdrawal (stored negative) is a credit row', () => {
    // 2 000 came back from the portfolio in May: the opening rose to 12 000.
    const s = statement(acct(12000), rows, [move('w', 'withdrawal', -2000, at('2026-05-10', 10))]);
    expect(s.deltas).toEqual([1000, 'move 2000', -200, 300]);
    expect(s.balances).toEqual([11000, 13000, 12800, 13100]);
    expect(s.opening).toBe(10000);
  });

  it('on the same day, a move sorts by when it was recorded', () => {
    const sameDay = [row('2026-06-01', -200, at('2026-06-01', 8)), row('2026-06-01', 100, at('2026-06-01', 14))];
    const s = statement(acct(5000), sameDay, [move('d', 'deposit', 5000, at('2026-06-01', 11))]);
    expect(s.deltas).toEqual([-200, 'move -5000', 100]);
    expect(s.balances).toEqual([9800, 4800, 4900]);
  });

  it("ignores other accounts' moves and buys/sells", () => {
    const s = statement(acct(10000), rows, [
      move('x', 'deposit', 5000, at('2026-10-12', 10), 'other'),
      { ...move('b', 'deposit', -700, at('2026-10-12', 10)), type: 'buy' },
    ]);
    expect(s.rows).toHaveLength(3);
    expect(s.balances).toEqual([11000, 10800, 11100]);
  });

  it('uses the amount the account was debited for a move in another currency', () => {
    // 1 000 USD bought with 500 EUR on the day; today 1 USD = 0.8 EUR.
    const a = acct(9500);
    const s = statement(a, rows, [move('d', 'deposit', 1000, at('2026-10-12', 10), 'a', 'USD', { accountAmount: 500, accountCurrency: 'EUR' })], { USD: 1, EUR: 0.8 });
    expect(last(s.deltas)).toBe('move -500');
    expect(s.balances).toEqual([11000, 10800, 11100, 10600]);
    expect(last(s.balances)).toBe(currentBalance(a, rows));
  });

  it('a cross-currency move without a stored amount falls back to today\'s rate', () => {
    const a = acct(9500);
    const s = statement(a, rows, [move('d', 'deposit', 1000, at('2026-10-12', 10), 'a', 'USD')], { USD: 1, EUR: 0.5 });
    expect(last(s.deltas)).toBe('move -500');
    expect(s.unconvertible).toBe(0);
    expect(s.opening).toBe(10000);
    expect(last(s.balances)).toBe(currentBalance(a, rows));
  });

  it('a cross-currency move without a stored amount or FX is left out, from the opening too, and counted', () => {
    const a = acct(9500);
    const s = statement(a, rows, [move('d', 'deposit', 1000, at('2026-10-12', 10), 'a', 'USD')], null);
    expect(s.rows).toHaveLength(3);
    expect(s.unconvertible).toBe(1);
    expect(s.opening).toBe(9500);
    expect(last(s.balances)).toBe(currentBalance(a, rows));
  });

  it('a stored amount needs no FX', () => {
    const s = statement(acct(9500), rows, [move('d', 'deposit', 1000, at('2026-10-12', 10), 'a', 'USD', { accountAmount: 500, accountCurrency: 'EUR' })], null);
    expect(s.unconvertible).toBe(0);
    expect(last(s.deltas)).toBe('move -500');
  });

  it('dates a move on its local day', () => {
    const { rows: [r] } = portfolioMoveRows(acct(0), [move('d', 'deposit', 1, at('2026-10-12', 23))], null);
    expect(r.date).toBe('2026-10-12');
  });
});
