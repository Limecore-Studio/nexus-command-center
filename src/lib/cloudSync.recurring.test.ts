import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeClient } from '../test/fakePostgrest';

// v1.19 — NCC#202: how recurring rules and their generated rows reach the
// server, and the store's delete (keep past entries / delete them too).
// Real sync queue, push handlers, Dexie and stores; only Supabase is a fake.

const holder = vi.hoisted(() => ({ client: null as any }));
vi.mock('./supabase', () => ({
  get supabase() {
    return holder.client;
  },
}));

const { pushQueue } = await import('./cloudSync');
const { enqueue } = await import('../db/syncQueue');
const { db } = await import('../db/database');
const { useRecurringStore } = await import('../store/useRecurringStore');
const { useFinanceStore } = await import('../store/useFinanceStore');

const USER = 'user-1';
type Write = { table: string; op: 'upsert' | 'update'; row: any; opts?: any };

function client() {
  const base = fakeClient({});
  const writes: Write[] = [];
  return {
    writes,
    from(table: string) {
      const b = base.from(table);
      b.upsert = (row: any, opts?: any) => {
        writes.push({ table, op: 'upsert', row, opts });
        return Promise.resolve({ error: null });
      };
      b.update = (row: any) => ({
        eq: () => {
          writes.push({ table, op: 'update', row });
          return Promise.resolve({ error: null });
        },
      });
      return b;
    },
  };
}

const RULE = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

beforeEach(async () => {
  holder.client = client();
  await Promise.all(db.tables.map((t) => t.clear()));
});

describe('push', () => {
  it("a generated row's first write ignores a row already on the server, and names its rule", async () => {
    const tx = { id: 'tx-1', type: 'expense', amount: 5, description: 'Gym', date: '2026-10-01', recurringRuleId: RULE, syncStatus: 'pending', createdAt: '' };
    await enqueue('transaction', tx.id, 'insert', tx);
    await pushQueue(USER);
    const [w] = holder.client.writes as Write[];
    expect(w.table).toBe('transactions');
    expect(w.row.recurring_rule_id).toBe(RULE);
    expect(w.opts).toEqual({ onConflict: 'id', ignoreDuplicates: true });
  });

  it('a later edit of a generated row is an ordinary upsert', async () => {
    const lot = { id: 'lot-1', holdingId: 'h1', quantity: 1, costPerUnit: 2, costCurrency: 'EUR', recurringRuleId: RULE, syncStatus: 'pending', createdAt: '' };
    await enqueue('portfolio_lot', lot.id, 'update', lot);
    await pushQueue(USER);
    const [w] = holder.client.writes as Write[];
    expect(w.row.recurring_rule_id).toBe(RULE);
    expect(w.opts).toBeUndefined();
  });

  it('an ordinary row sends no recurring_rule_id (works before the migration too)', async () => {
    const tx = { id: 'tx-2', type: 'expense', amount: 5, description: 'x', date: '2026-10-01', syncStatus: 'pending', createdAt: '' };
    await enqueue('transaction', tx.id, 'insert', tx);
    await pushQueue(USER);
    const [w] = holder.client.writes as Write[];
    expect('recurring_rule_id' in w.row).toBe(false);
    expect(w.opts).toBeUndefined();
  });

  it('a rule pushes its server columns, never the local-only waitingSince; a delete is a tombstone', async () => {
    const rule = {
      id: RULE, kind: 'transaction', template: { type: 'expense', amount: 5, description: 'Gym' },
      every: 1, unit: 'month', anchorDay: 31, startDate: '2026-01-31', lastMaterializedDate: '2026-09-30',
      waitingSince: '2026-10-31', syncStatus: 'pending', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z',
    };
    await enqueue('recurring_rule', RULE, 'insert', rule);
    await enqueue('recurring_rule', RULE, 'delete', { id: RULE });
    await pushQueue(USER);
    const [up, del] = holder.client.writes as Write[];
    expect(up.table).toBe('recurring_rules');
    expect(up.row).toMatchObject({
      id: RULE, user_id: USER, kind: 'transaction', every: 1, unit: 'month', anchor_day: 31,
      start_date: '2026-01-31', end_date: null, last_materialized_date: '2026-09-30', paused_at: null,
    });
    expect('waitingSince' in up.row || 'waiting_since' in up.row).toBe(false);
    expect(del).toMatchObject({ table: 'recurring_rules', op: 'update' });
    expect(Object.keys(del.row).sort()).toEqual(['deleted_at', 'updated_at']);
  });
});

describe('deleting a rule', () => {
  async function ruleWithHistory() {
    await db.recurringRules.put({
      id: RULE, kind: 'transaction', template: { type: 'expense', amount: 5, description: 'Gym', accountId: 'a' },
      every: 1, unit: 'month', startDate: '2026-08-01', lastMaterializedDate: '2026-10-01', syncStatus: 'synced', createdAt: '',
    } as any);
    for (const date of ['2026-08-01', '2026-09-01', '2026-10-01']) {
      await db.transactions.put({ id: `g-${date}`, type: 'expense', amount: 5, description: 'Gym', date, recurringRuleId: RULE, syncStatus: 'synced', createdAt: '' });
    }
    await db.transactions.put({ id: 'own', type: 'expense', amount: 9, description: 'Other', date: '2026-10-02', syncStatus: 'synced', createdAt: '' });
    await useFinanceStore.getState().load();
  }

  it('keeps past entries by default choice, and counts them for the prompt', async () => {
    await ruleWithHistory();
    expect(await useRecurringStore.getState().countGenerated(RULE)).toBe(3);
    await useRecurringStore.getState().remove(RULE, { deletePast: false });
    expect(await db.recurringRules.count()).toBe(0);
    expect(await db.transactions.count()).toBe(4);
    const q = await db.syncQueue.toArray();
    expect(q.map((i) => `${i.entityType}:${i.operation}`)).toEqual(['recurring_rule:delete']);
  });

  it('deletes them too when asked, and nothing else', async () => {
    await ruleWithHistory();
    await useRecurringStore.getState().remove(RULE, { deletePast: true });
    expect((await db.transactions.toArray()).map((t) => t.id)).toEqual(['own']);
    const q = await db.syncQueue.toArray();
    expect(q.filter((i) => i.entityType === 'transaction' && i.operation === 'delete')).toHaveLength(3);
  });
});
