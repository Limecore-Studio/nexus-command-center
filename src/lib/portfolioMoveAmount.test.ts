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
const { useSettingsStore } = await import('../store/useSettingsStore');
const { computeAccountBalance } = await import('./accountBalance');
const { localDateKey } = await import('../utils/formatters');

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
  await db.transactions.clear();
  await db.syncQueue.clear();
  await db.manualAssets.clear();
  useSettingsStore.setState({ baseCurrency: 'EUR' } as any);
  await db.manualAssets.put(ACCOUNT);
  // Rates anchored to USD: 1 USD = 0.5 EUR on the day of the move.
  useFinanceStore.setState({ manualAssets: [ACCOUNT], portfolioCashEntries: [], transactions: [], fxRates: { USD: 1, EUR: 0.5 } } as any);
});

// v1.22 (NCC#257): a Deposit / Withdraw no longer rewrites the account's
// opening balance. It books a dated transfer on the account (in the base
// currency, like every transaction) and a cash entry with no accountId.
describe('portfolio moves are transfers (NCC#257)', () => {
  const balance = () =>
    computeAccountBalance(useFinanceStore.getState().manualAssets[0] as any, useFinanceStore.getState().transactions, { USD: 1, EUR: 0.5 }, 'EUR').balance;

  it('a deposit is a transfer out of the account plus a cash deposit; the opening balance stays', async () => {
    await useFinanceStore.getState().depositToPortfolio({ amount: 1000, currency: 'USD', accountId: ACCOUNT.id });
    const [tx] = await db.transactions.toArray();
    const [e] = await db.portfolioCashEntries.toArray();
    expect(tx).toMatchObject({ type: 'transfer', amount: 500, accountId: ACCOUNT.id, description: 'Portfolio deposit', date: localDateKey(new Date()) });
    expect(tx.destinationAccountId).toBeUndefined();
    expect(e).toMatchObject({ type: 'deposit', amount: 1000, currency: 'USD', relatedId: tx.id });
    expect(e.accountId).toBeUndefined();
    expect(useFinanceStore.getState().manualAssets[0].startingBalance).toBe(10000);
    expect(balance()).toBe(9500);
    const q = await db.syncQueue.toArray();
    expect(q.map((i) => i.entityType).sort()).toEqual(['portfolio_cash_entry', 'transaction']);
  });

  it('a withdrawal is a transfer into the account plus a negative cash entry', async () => {
    await useFinanceStore.getState().withdrawFromPortfolio({ amount: 1000, currency: 'USD', accountId: ACCOUNT.id, note: 'Rent' });
    const [tx] = await db.transactions.toArray();
    const [e] = await db.portfolioCashEntries.toArray();
    expect(tx).toMatchObject({ type: 'transfer', amount: 500, destinationAccountId: ACCOUNT.id, description: 'Rent' });
    expect(tx.accountId).toBeUndefined();
    expect(e).toMatchObject({ type: 'withdrawal', amount: -1000, currency: 'USD', relatedId: tx.id, note: 'Rent' });
    expect(e.accountId).toBeUndefined();
    expect(balance()).toBe(10500);
    expect(await db.syncQueue.filter((i) => i.entityType === 'manual_asset').count()).toBe(0);
  });
});

// v1.18.1 (NCC#176): entries made before v1.22 carry the account side as a
// local-only amount; the pull must keep it.
describe('portfolio move amount in the account currency (NCC#176)', () => {
  it('the pull keeps the local-only amount', async () => {
    const local = {
      id: '33333333-3333-4333-8333-333333333333', type: 'deposit', amount: 1000, currency: 'USD', accountId: ACCOUNT.id,
      accountAmount: 500, accountCurrency: 'EUR', createdAt: '2026-10-12T10:00:00.000Z', syncStatus: 'synced',
    } as any;
    await db.portfolioCashEntries.put(local);
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
