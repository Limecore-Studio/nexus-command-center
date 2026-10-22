import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeClient } from '../test/fakePostgrest';

// v1.18.1 (NCC#176) — a Deposit / Withdraw records what the account was
// debited or credited, in the account's currency, so the history views stop
// re-converting a cross-currency move at today's rate. The field has no
// server column (local-only), so the pull must not wipe it.

const holder = vi.hoisted(() => ({ client: null as any }));
vi.mock('./supabase', () => ({
  get supabase() {
    return holder.client;
  },
}));
vi.stubGlobal('window', { location: { origin: 'http://localhost' }, addEventListener() {}, removeEventListener() {} });

const { db } = await import('../db/database');
const { useFinanceStore } = await import('../store/useFinanceStore');
const { hydratePortfolioCashFromCloud } = await import('./cloudSyncHydrate');

const ACCOUNT = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Checking',
  accountType: 'checking',
  assetType: 'checking',
  currency: 'EUR',
  startingBalance: 10000,
  value: 10000,
  createdAt: '2026-01-01T00:00:00Z',
  syncStatus: 'synced',
} as any;

beforeEach(async () => {
  holder.client = fakeClient({});
  await db.portfolioCashEntries.clear();
  await db.manualAssets.clear();
  await db.manualAssets.put(ACCOUNT);
  // Rates anchored to USD: 1 USD = 0.5 EUR on the day of the move.
  useFinanceStore.setState({ manualAssets: [ACCOUNT], portfolioCashEntries: [], fxRates: { USD: 1, EUR: 0.5 } } as any);
});

describe('portfolio move amount in the account currency (NCC#176)', () => {
  it('a deposit stores what it took from the account', async () => {
    await useFinanceStore.getState().depositToPortfolio({ amount: 1000, currency: 'USD', accountId: ACCOUNT.id });
    const [e] = await db.portfolioCashEntries.toArray();
    expect(e).toMatchObject({ type: 'deposit', amount: 1000, currency: 'USD', accountAmount: 500, accountCurrency: 'EUR' });
    expect(useFinanceStore.getState().manualAssets[0].startingBalance).toBe(9500);
  });

  it('a withdrawal stores what it put into the account, signed like the entry', async () => {
    await useFinanceStore.getState().withdrawFromPortfolio({ amount: 1000, currency: 'USD', accountId: ACCOUNT.id });
    const [e] = await db.portfolioCashEntries.toArray();
    expect(e).toMatchObject({ type: 'withdrawal', amount: -1000, accountAmount: -500, accountCurrency: 'EUR' });
  });

  it('the pull keeps the local-only amount', async () => {
    await useFinanceStore.getState().depositToPortfolio({ amount: 1000, currency: 'USD', accountId: ACCOUNT.id });
    const [local] = await db.portfolioCashEntries.toArray();
    // v1.18.2 merge: the push has landed (NCC#146 skips rows still queued).
    await db.syncQueue.clear();
    holder.client = fakeClient({
      portfolio_cash_entries: [{
        id: local.id, user_id: 'u', type: 'deposit', amount: 1000, currency: 'USD',
        account_id: ACCOUNT.id, related_id: null, note: null, created_at: local.createdAt,
      }],
    });
    const res = await hydratePortfolioCashFromCloud('u');
    expect(res.errors).toEqual([]);
    const after = await db.portfolioCashEntries.get(local.id);
    expect(after).toMatchObject({ syncStatus: 'synced', accountAmount: 500, accountCurrency: 'EUR' });
  });

  it('a server row with no local copy hydrates without the local-only amount', async () => {
    const id = '22222222-2222-4222-8222-222222222222';
    holder.client = fakeClient({
      portfolio_cash_entries: [{
        id, user_id: 'u', type: 'deposit', amount: 1000, currency: 'USD',
        account_id: ACCOUNT.id, related_id: null, note: null, created_at: '2026-10-12T10:00:00Z',
      }],
    });
    const res = await hydratePortfolioCashFromCloud('u');
    expect(res.errors).toEqual([]);
    const row = await db.portfolioCashEntries.get(id);
    expect(row).toMatchObject({ id, amount: 1000, syncStatus: 'synced' });
    expect(row).not.toHaveProperty('accountAmount');
    expect(row).not.toHaveProperty('accountCurrency');
  });
});
