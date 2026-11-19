import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeClient } from '../test/fakePostgrest';

// v1.22 (NCC#250) — deleting a holding gave nothing back to portfolio cash,
// while deleting its lots one by one did.

const holder = vi.hoisted(() => ({ client: null as any }));
vi.mock('./supabase', () => ({
  get supabase() {
    return holder.client;
  },
}));
vi.stubGlobal('window', { location: { origin: 'http://localhost' }, addEventListener() {}, removeEventListener() {} });

const { db } = await import('../db/database');
const { useFinanceStore } = await import('../store/useFinanceStore');

const H = 'h1';
const holding = { id: H, assetType: 'stock', ticker: 'ABC', quantity: 2, syncStatus: 'synced', createdAt: '' } as any;
const lots = [
  { id: 'l1', holdingId: H, quantity: 1, costPerUnit: 400, costCurrency: 'EUR', syncStatus: 'synced', createdAt: '' },
  { id: 'l2', holdingId: H, quantity: 1, costPerUnit: 600, costCurrency: 'EUR', syncStatus: 'synced', createdAt: '' },
] as any[];
const buys = [
  { id: 'c1', type: 'buy', amount: -400, currency: 'EUR', relatedId: 'l1', createdAt: '', syncStatus: 'synced' },
  { id: 'c2', type: 'buy', amount: -600, currency: 'EUR', relatedId: 'l2', createdAt: '', syncStatus: 'synced' },
  { id: 'c3', type: 'deposit', amount: 2000, currency: 'EUR', createdAt: '', syncStatus: 'synced' },
] as any[];

beforeEach(async () => {
  holder.client = fakeClient({});
  await Promise.all(db.tables.map((t) => t.clear()));
  await db.portfolioHoldings.put(holding);
  await db.portfolioLots.bulkPut(lots);
  await db.portfolioCashEntries.bulkPut(buys);
  useFinanceStore.setState({ holdings: [holding], portfolioLots: lots, portfolioCashEntries: buys, stockSales: [] } as any);
});

describe('deleteHolding (NCC#250)', () => {
  it("gives its lots' purchases back to portfolio cash", async () => {
    await useFinanceStore.getState().deleteHolding(H);
    expect((await db.portfolioCashEntries.toArray()).map((e) => e.id)).toEqual(['c3']);
    expect(useFinanceStore.getState().portfolioCashEntries.map((e) => e.id)).toEqual(['c3']);
    const deletes = (await db.syncQueue.toArray()).filter((q) => q.entityType === 'portfolio_cash_entry' && q.operation === 'delete');
    expect(deletes.map((q) => q.entityId).sort()).toEqual(['c1', 'c2']);
  });

  it('leaves cash as it is once anything was sold', async () => {
    useFinanceStore.setState({ stockSales: [{ id: 's1', holdingId: H, ticker: 'ABC', sharesSold: 1 }] } as any);
    await useFinanceStore.getState().deleteHolding(H);
    expect((await db.portfolioCashEntries.toArray()).map((e) => e.id).sort()).toEqual(['c1', 'c2', 'c3']);
  });
});
