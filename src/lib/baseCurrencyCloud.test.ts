// v1.21 (NCC#248): the account's base currency. A stand-in Supabase holds one
// user_preferences row; Dexie is real (fake-indexeddb).
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  row: null as null | { user_id: string; ncc_base_currency: string | null },
  missingColumn: false,
  failRead: false,
  calls: [] as string[],
  // NCC#266: make the Dexie rewrite throw; optionally go offline as it does.
  failApply: false,
  offlineOnApply: false,
}));

vi.mock('./currencyRebase', async (importOriginal) => {
  const real = await importOriginal<typeof import('./currencyRebase')>();
  return {
    ...real,
    applyCurrencyRebase: async (plan: Parameters<typeof real.applyCurrencyRebase>[0]) => {
      if (h.failApply) {
        if (h.offlineOnApply) h.failRead = true;
        throw new Error('QuotaExceededError');
      }
      return real.applyCurrencyRebase(plan);
    },
  };
});

vi.mock('../lib/entitlement', () => ({ clearEntitlement: vi.fn() }));
vi.mock('../api/fxRates', () => ({
  // USD-based: 1 EUR = 90 INR.
  ensureFxRates: async () => ({ base: 'USD', rates: { EUR: 0.9, INR: 81 }, ts: 0 }),
  convertSync: (amount: number, from: string, to: string, rates: Record<string, number> | null) => {
    if (from === to) return amount;
    if (!rates || !rates[from] || !rates[to]) return null;
    return (amount / rates[from]) * rates[to];
  },
}));
vi.mock('./supabase', () => {
  const missing = { code: '42703', message: 'column user_preferences.ncc_base_currency does not exist' };
  function from() {
    const filters: Array<[string, string, unknown]> = [];
    let op: 'select' | 'update' | 'insert' = 'select';
    let patch: Record<string, unknown> = {};
    const matches = () =>
      !!h.row &&
      filters.every(([kind, col, val]) => {
        const v = (h.row as Record<string, unknown>)[col];
        return kind === 'is' ? v === val : v === val;
      });
    const q: Record<string, unknown> = {
      select() { return q; },
      eq(col: string, val: unknown) { filters.push(['eq', col, val]); return q; },
      is(col: string, val: unknown) { filters.push(['is', col, val]); return q; },
      abortSignal() { return q; },
      update(p: Record<string, unknown>) { op = 'update'; patch = p; return q; },
      async maybeSingle() {
        h.calls.push('read');
        if (h.failRead) return { data: null, error: { code: 'XX', message: 'offline' } };
        if (h.missingColumn) return { data: null, error: missing };
        return { data: matches() ? { ncc_base_currency: h.row!.ncc_base_currency } : null, error: null };
      },
      insert(p: { user_id: string; ncc_base_currency: string }) {
        h.calls.push('insert');
        if (h.missingColumn) return Promise.resolve({ error: missing });
        if (h.row) return Promise.resolve({ error: { code: '23505', message: 'duplicate key' } });
        h.row = { user_id: p.user_id, ncc_base_currency: p.ncc_base_currency };
        return Promise.resolve({ error: null });
      },
      then(resolve: (v: unknown) => void) {
        // Awaiting an update(...).eq(...).select(...) chain.
        if (op === 'update') {
          h.calls.push('update');
          if (h.missingColumn) return resolve({ data: null, error: missing });
          if (matches()) { Object.assign(h.row!, patch); return resolve({ data: [{ user_id: h.row!.user_id }], error: null }); }
          return resolve({ data: [], error: null });
        }
        return resolve({ data: null, error: null });
      },
    };
    return q;
  }
  return { supabase: { from } };
});

import { db } from '../db/database';
import { enqueue } from '../db/syncQueue';
import { useSettingsStore } from '../store/useSettingsStore';
import {
  adoptCloudBaseCurrency,
  claimCloudBaseCurrency,
  conversionProbe,
  convertBaseCurrency,
  isMissingColumn,
  readCloudBaseCurrency,
  resolvePendingConversion,
} from './baseCurrencyCloud';
import { planCurrencyRebase } from './currencyRebase';
import { readConversionMarker, writeConversionMarker } from './currencyConversionMarker';

const U = 'user-1';
const NOW = '2026-11-14T10:00:00.000Z';

beforeEach(async () => {
  h.row = null; h.missingColumn = false; h.failRead = false; h.calls = [];
  h.failApply = false; h.offlineOnApply = false;
  localStorage.removeItem('ncc.currencyConversion');
  await Promise.all([db.transactions.clear(), db.budgetCategories.clear(), db.recurringRules.clear(), db.syncQueue.clear()]);
  useSettingsStore.setState({ baseCurrency: 'EUR' });
});

describe('readCloudBaseCurrency', () => {
  it('reads null when never converted, and the code once set', async () => {
    expect(await readCloudBaseCurrency(U)).toEqual({ kind: 'ok', code: null });
    h.row = { user_id: U, ncc_base_currency: 'INR' };
    expect(await readCloudBaseCurrency(U)).toEqual({ kind: 'ok', code: 'INR' });
  });
  it('reports the migration missing as unsupported, and other failures as error', async () => {
    h.missingColumn = true;
    expect(await readCloudBaseCurrency(U)).toEqual({ kind: 'unsupported' });
    h.missingColumn = false; h.failRead = true;
    expect(await readCloudBaseCurrency(U)).toEqual({ kind: 'error' });
  });
  it('recognises both forms of the missing-column error', () => {
    expect(isMissingColumn({ code: '42703' })).toBe(true);
    expect(isMissingColumn({ code: 'PGRST204' })).toBe(true);
    expect(isMissingColumn({ code: '23505' })).toBe(false);
  });
});

describe('claimCloudBaseCurrency', () => {
  it('creates the row when the account has none', async () => {
    expect(await claimCloudBaseCurrency(U, 'EUR', 'INR')).toEqual({ kind: 'ok' });
    expect(h.row).toEqual({ user_id: U, ncc_base_currency: 'INR' });
  });
  it('claims a row that never held a currency', async () => {
    h.row = { user_id: U, ncc_base_currency: null };
    expect(await claimCloudBaseCurrency(U, 'EUR', 'INR')).toEqual({ kind: 'ok' });
    expect(h.row!.ncc_base_currency).toBe('INR');
  });
  it('moves the account currency on from the one being converted from', async () => {
    h.row = { user_id: U, ncc_base_currency: 'INR' };
    expect(await claimCloudBaseCurrency(U, 'INR', 'USD')).toEqual({ kind: 'ok' });
    expect(h.row!.ncc_base_currency).toBe('USD');
  });
  it('refuses when another device already changed it: the second conversion never runs', async () => {
    h.row = { user_id: U, ncc_base_currency: 'INR' };
    expect(await claimCloudBaseCurrency(U, 'EUR', 'USD')).toEqual({ kind: 'conflict', current: 'INR' });
    expect(h.row!.ncc_base_currency).toBe('INR');
  });
  it('is unsupported until the migration is applied, and changes nothing', async () => {
    h.missingColumn = true;
    expect(await claimCloudBaseCurrency(U, 'EUR', 'INR')).toEqual({ kind: 'unsupported' });
    expect(h.row).toBeNull();
  });
});

describe('adoptCloudBaseCurrency', () => {
  it('does nothing while the account was never converted', async () => {
    expect(await adoptCloudBaseCurrency(U)).toBeNull();
    expect(useSettingsStore.getState().baseCurrency).toBe('EUR');
  });

  it('adopts the account currency without converting synced rows, and converts only unsynced ones', async () => {
    h.row = { user_id: U, ncc_base_currency: 'INR' };
    await db.transactions.bulkPut([
      // Synced: already converted on the server by the other device.
      { id: 'synced', amount: 108000, description: 's', date: '2026-11-01', type: 'expense', syncStatus: 'synced', createdAt: NOW },
      // Edited here, offline, in EUR, before this device knew.
      { id: 'local', amount: 10, description: 'l', date: '2026-11-02', type: 'expense', syncStatus: 'pending', createdAt: NOW },
    ]);
    await enqueue('transaction', 'local', 'update', { id: 'local', amount: 10 });

    expect(await adoptCloudBaseCurrency(U)).toBe('INR');
    expect(useSettingsStore.getState().baseCurrency).toBe('INR');
    expect((await db.transactions.get('synced'))!.amount).toBe(108000);
    expect((await db.transactions.get('local'))!.amount).toBe(900);
    // The newest queued update for the row carries the converted amount.
    const q = (await db.syncQueue.toArray()).filter((i) => i.entityId === 'local').sort((x, y) => x.createdAt.localeCompare(y.createdAt));
    expect(JSON.parse(q[q.length - 1].payload).amount).toBe(900);
  });

  it('is a no-op when the device already uses the account currency', async () => {
    h.row = { user_id: U, ncc_base_currency: 'EUR' };
    expect(await adoptCloudBaseCurrency(U)).toBeNull();
  });
});

describe('convertBaseCurrency (NCC#266)', () => {
  const RATES = { EUR: 0.9, INR: 81 };
  async function seedAndPlan() {
    const tx = [{ id: 't1', amount: 10, description: 'x', date: '2026-11-01', type: 'expense', syncStatus: 'synced', createdAt: NOW }];
    await db.transactions.bulkPut(tx as never);
    const originals = { transactions: await db.transactions.toArray(), budgets: [], rules: [] };
    const plan = planCurrencyRebase({ from: 'EUR', to: 'INR', rates: RATES, ...originals, userId: U })!;
    return { plan, probe: conversionProbe(plan, originals) };
  }

  it('converts, claims the account and leaves no marker', async () => {
    h.row = { user_id: U, ncc_base_currency: null };
    const { plan, probe } = await seedAndPlan();
    expect(await convertBaseCurrency({ from: 'EUR', to: 'INR', userId: U, plan, probe })).toEqual({ kind: 'ok' });
    expect((await db.transactions.get('t1'))!.amount).toBe(900);
    expect(useSettingsStore.getState().baseCurrency).toBe('INR');
    expect(h.row!.ncc_base_currency).toBe('INR');
    expect(readConversionMarker()).toBeNull();
  });

  it('a rewrite that throws after the claim puts the device and the account back on the old currency', async () => {
    h.row = { user_id: U, ncc_base_currency: 'EUR' };
    const { plan, probe } = await seedAndPlan();
    h.failApply = true;
    expect(await convertBaseCurrency({ from: 'EUR', to: 'INR', userId: U, plan, probe })).toEqual({ kind: 'failed' });
    expect((await db.transactions.get('t1'))!.amount).toBe(10);
    expect(useSettingsStore.getState().baseCurrency).toBe('EUR');
    expect(h.row!.ncc_base_currency).toBe('EUR');
    expect(readConversionMarker()).toBeNull();
  });

  it('when the account cannot be set back (offline), the marker holds every sync until it is', async () => {
    h.row = { user_id: U, ncc_base_currency: 'EUR' };
    const { plan, probe } = await seedAndPlan();
    h.failApply = true; h.offlineOnApply = true;
    expect(await convertBaseCurrency({ from: 'EUR', to: 'INR', userId: U, plan, probe })).toEqual({ kind: 'failedPending' });
    expect(useSettingsStore.getState().baseCurrency).toBe('EUR');
    expect(h.row!.ncc_base_currency).toBe('INR'); // still the claim
    expect(readConversionMarker()).toMatchObject({ from: 'EUR', to: 'INR', claimed: true });

    // Still offline: the sync must not go ahead.
    expect(await resolvePendingConversion()).toBe(false);
    // Back online: the account is set back, and the sync may run.
    h.failRead = false;
    expect(await resolvePendingConversion()).toBe(true);
    expect(h.row!.ncc_base_currency).toBe('EUR');
    expect(readConversionMarker()).toBeNull();
    expect((await db.transactions.get('t1'))!.amount).toBe(10);
  });

  it('a conversion cut off after the rewrite committed is finished, not undone', async () => {
    h.row = { user_id: U, ncc_base_currency: 'INR' };
    const { plan, probe } = await seedAndPlan();
    await db.transactions.put({ ...(await db.transactions.get('t1'))!, amount: 900 });
    writeConversionMarker({ from: 'EUR', to: 'INR', userId: U, claimed: true, probe });
    expect(plan.transactions[0].amount).toBe(900);
    expect(await resolvePendingConversion()).toBe(true);
    expect(useSettingsStore.getState().baseCurrency).toBe('INR');
    expect(h.row!.ncc_base_currency).toBe('INR');
  });

  it('a conversion cut off before the rewrite is undone, including a claim whose reply was lost', async () => {
    h.row = { user_id: U, ncc_base_currency: 'INR' }; // the claim reached the server
    const { probe } = await seedAndPlan();
    useSettingsStore.setState({ baseCurrency: 'INR' });
    writeConversionMarker({ from: 'EUR', to: 'INR', userId: U, claimed: false, probe });
    expect(await resolvePendingConversion()).toBe(true);
    expect(useSettingsStore.getState().baseCurrency).toBe('EUR');
    expect(h.row!.ncc_base_currency).toBe('EUR');
    expect((await db.transactions.get('t1'))!.amount).toBe(10);
  });

  it('a failed claim changes nothing and leaves no marker', async () => {
    const { plan, probe } = await seedAndPlan();
    h.failRead = true;
    expect(await convertBaseCurrency({ from: 'EUR', to: 'INR', userId: U, plan, probe })).toEqual({ kind: 'claimFailed' });
    expect(useSettingsStore.getState().baseCurrency).toBe('EUR');
    expect(readConversionMarker()).toBeNull();
  });
});
