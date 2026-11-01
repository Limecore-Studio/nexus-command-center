import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeClient } from '../test/fakePostgrest';

// v1.20 (NCC#228) — finance rows were labelled EUR on the server whatever the
// base currency: a user on INR held rupee amounts marked as euros.

const holder = vi.hoisted(() => ({ client: null as any }));
vi.mock('./supabase', () => ({
  get supabase() {
    return holder.client;
  },
}));

const { pushQueue } = await import('./cloudSync');
const { db } = await import('../db/database');
const { useSettingsStore } = await import('../store/useSettingsStore');

const T0 = '2026-11-01T08:00:00Z';

async function queue(entityType: string, payload: { id: string }) {
  await db.syncQueue.add({
    id: crypto.randomUUID(),
    entityType,
    entityId: payload.id,
    operation: 'insert',
    payload: JSON.stringify(payload),
    createdAt: T0,
  } as any);
}

const tx = (id: string) => ({ id, amount: 1200, description: 'Market', date: '2026-11-01', type: 'expense', syncStatus: 'pending', createdAt: T0 });
const budget = (id: string) => ({ id, name: 'Groceries', monthlyLimit: 5000, syncStatus: 'pending', createdAt: T0 });

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
  localStorage.removeItem('settings.baseCurrency');
  holder.client = fakeClient({ transactions: [], budget_categories: [] });
});

describe('the currency on pushed finance rows (NCC#228)', () => {
  it('is the base currency', async () => {
    localStorage.setItem('settings.baseCurrency', 'INR');
    await queue('budget_category', budget(crypto.randomUUID()));
    await queue('transaction', tx(crypto.randomUUID()));

    const result = await pushQueue('user-1');

    expect(result.errors).toEqual([]);
    expect(holder.client.tables.transactions[0]).toMatchObject({ amount: 1200, currency: 'INR' });
    expect(holder.client.tables.budget_categories[0]).toMatchObject({ monthly_limit: 5000, currency: 'INR' });
  });

  it('does not wait for the settings store: its default is not the answer', async () => {
    localStorage.setItem('settings.baseCurrency', 'USD');
    expect(useSettingsStore.getState().baseCurrency).toBe('EUR'); // `load` has not run
    await queue('transaction', tx(crypto.randomUUID()));

    await pushQueue('user-1');

    expect(holder.client.tables.transactions[0].currency).toBe('USD');
  });

  it('is EUR for someone who never chose one', async () => {
    await queue('transaction', tx(crypto.randomUUID()));
    await pushQueue('user-1');
    expect(holder.client.tables.transactions[0].currency).toBe('EUR');
  });
});
