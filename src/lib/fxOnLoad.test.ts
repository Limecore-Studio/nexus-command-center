import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeClient } from '../test/fakePostgrest';

// v1.22 (NCC#251) — FX rates load with the finance data whenever an account
// or cash entry is in another currency, portfolio or not.

const holder = vi.hoisted(() => ({ client: null as any, fx: vi.fn() }));
vi.mock('./supabase', () => ({
  get supabase() {
    return holder.client;
  },
}));
vi.mock('../api/fxRates', async (orig) => ({
  ...(await orig<typeof import('../api/fxRates')>()),
  ensureFxRates: holder.fx,
}));
vi.stubGlobal('window', { location: { origin: 'http://localhost' }, addEventListener() {}, removeEventListener() {} });

const { db } = await import('../db/database');
const { useFinanceStore } = await import('../store/useFinanceStore');
const { useSettingsStore } = await import('../store/useSettingsStore');

const account = (currency: string) => ({ id: `a-${currency}`, name: 'x', accountType: 'checking', currency, startingBalance: 0, createdAt: '', syncStatus: 'synced' }) as any;

beforeEach(async () => {
  holder.client = fakeClient({});
  holder.fx.mockReset().mockResolvedValue({ base: 'USD', rates: { USD: 1, EUR: 0.9 }, ts: 0 });
  await Promise.all(db.tables.map((t) => t.clear()));
  useSettingsStore.setState({ baseCurrency: 'EUR' } as any);
  useFinanceStore.setState({ fxRates: null } as any);
});

describe('FX rates without a portfolio (NCC#251)', () => {
  it('load() fetches them when an account is in another currency', async () => {
    await db.manualAssets.put(account('USD'));
    await useFinanceStore.getState().load();
    await vi.waitFor(() => expect(useFinanceStore.getState().fxRates).toEqual({ USD: 1, EUR: 0.9 }));
  });

  it('does not fetch when everything is in the base currency', async () => {
    await db.manualAssets.put(account('EUR'));
    await useFinanceStore.getState().load();
    expect(holder.fx).not.toHaveBeenCalled();
  });
});
