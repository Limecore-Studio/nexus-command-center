import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import process from 'node:process';

// v1.18.1 (NCC#176) — the net-worth trend put a portfolio move (and an
// account's creation) on its UTC day, while the account statement uses the
// local day. Off UTC, a move near midnight at a month's edge landed in
// different months in the two views. This file runs in New York time (Vitest
// runs each file in its own process here, so the zone change stays here).

// The FX module reaches the supabase client, which needs a WebSocket that
// Node 20 (CI) does not have; these tests never touch it.
vi.mock('./supabase', () => ({ supabase: {} }));

const ORIGINAL_TZ = process.env.TZ;
let buildNetWorthTrend: typeof import('./netWorthTrend').buildNetWorthTrend;
let portfolioMoveRows: typeof import('./accountStatement').portfolioMoveRows;

beforeAll(async () => {
  process.env.TZ = 'America/New_York';
  vi.stubGlobal('window', { location: { origin: 'http://localhost' }, addEventListener() {}, removeEventListener() {} });
  ({ buildNetWorthTrend } = await import('./netWorthTrend'));
  ({ portfolioMoveRows } = await import('./accountStatement'));
});
afterAll(() => {
  vi.unstubAllGlobals();
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

// 02:00 UTC on 1 October is 22:00 on 30 September in New York.
const MOVE_AT = '2026-10-01T02:00:00Z';
// 02:00 UTC on 1 September is 31 August in New York.
const account = { id: 'a', name: 'Checking', accountType: 'checking', currency: 'EUR', startingBalance: 5000, value: 5000, createdAt: '2026-09-01T02:00:00Z', syncStatus: 'synced' };
const deposit = { id: 'd', type: 'deposit', amount: 5000, currency: 'EUR', accountId: 'a', createdAt: MOVE_AT, accountAmount: 5000, accountCurrency: 'EUR', syncStatus: 'synced' };

describe('portfolio moves on their local day, west of UTC (NCC#176)', () => {
  it('the trend puts a late-evening move in the local month', () => {
    const t = buildNetWorthTrend({
      accounts: [account] as any,
      transactions: [],
      snapshots: [],
      cashEntries: [deposit] as any,
      fxRates: null,
      baseCurrency: 'EUR',
      months: 3,
      today: '2026-10-12',
    });
    const sep = t.points.find((p) => p.month === '2026-09')!;
    // The move happened on 30 September locally: by September's end the
    // money is already in the portfolio, not still in the account.
    expect(sep.accountsBase).toBe(5000);
    expect(sep.portfolioCashBase).toBe(5000);
    expect(sep.total).toBe(10000);
  });

  it('the trend counts an account from its local creation day', () => {
    const t = buildNetWorthTrend({
      accounts: [account] as any,
      transactions: [],
      snapshots: [],
      cashEntries: [deposit] as any,
      fxRates: null,
      baseCurrency: 'EUR',
      months: 3,
      today: '2026-10-12',
    });
    expect(t.points[0].month).toBe('2026-08');
    expect(t.points[0].addedAccounts).toEqual(['Checking']);
    expect(t.points[0].total).toBe(10000);
  });

  it('the statement dates the same move on the same local day', () => {
    const { rows: [r] } = portfolioMoveRows(account, [deposit] as any, null);
    expect(r.date).toBe('2026-09-30');
  });
});
