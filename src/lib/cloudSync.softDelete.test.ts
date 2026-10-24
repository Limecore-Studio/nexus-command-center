import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeClient } from '../test/fakePostgrest';
import { legacyIdToUuid } from '../utils/uuid';

// v1.16 (NCC#56 part 2, registry P6) — NCC's own deletes become tombstones,
// and every NCC device removes what another one deleted. Through the REAL
// sync queue, push handlers and pullAll; only the Supabase client is a
// stand-in.

const holder = vi.hoisted(() => ({ client: null as any }));
vi.mock('./supabase', () => ({
  get supabase() {
    return holder.client;
  },
}));

const { pushQueue, pullAll } = await import('./cloudSync');
const { enqueue } = await import('../db/syncQueue');
const { db } = await import('../db/database');

const USER = 'user-1';
const T0 = '2026-09-01T00:00:00Z';
const DELETED = '2026-09-20T00:00:00Z';
const uuid = () => crypto.randomUUID();

type Write = { table: string; op: 'update' | 'delete' | 'upsert'; row?: any; eq?: [string, unknown] };

/** The shared read-side fake plus a capture of writes. Kept local, as in
 *  cloudSync.stamps.test.ts: the shared fake gains writes in #89, a sibling
 *  of this stack. */
function client(tables: Record<string, any[]>, opts?: Parameters<typeof fakeClient>[1], updateError: any = null) {
  const base = fakeClient(tables, opts);
  const writes: Write[] = [];
  return {
    requests: base.requests,
    writes,
    from(table: string) {
      const b = base.from(table);
      const done = { error: null };
      b.upsert = (row: any) => {
        writes.push({ table, op: 'upsert', row });
        return Promise.resolve(done);
      };
      b.update = (row: any) => ({
        eq: (col: string, val: unknown) => {
          writes.push({ table, op: 'update', row, eq: [col, val] });
          return Promise.resolve(updateError ? { error: updateError } : done);
        },
      });
      b.delete = () => ({
        eq: (col: string, val: unknown) => {
          writes.push({ table, op: 'delete', eq: [col, val] });
          return Promise.resolve(done);
        },
      });
      return b;
    },
  };
}

beforeEach(async () => {
  holder.client = client({});
  await Promise.all(db.tables.map((t) => t.clear()));
});

// entity type → server table, for the six handlers that used to hard-delete.
const SOFT = [
  ['transaction', 'transactions'],
  ['budget_category', 'budget_categories'],
  ['portfolio_lot', 'portfolio_lots'],
  ['manual_asset', 'manual_assets'],
  ['watchlist_item', 'watchlist_items'],
  ['task', 'tasks'],
] as const;

describe('push: a delete is a tombstone, never a DELETE', () => {
  it.each(SOFT)('%s → tombstones %s', async (entityType, table) => {
    const id = uuid();
    await enqueue(entityType, id, 'delete', { id });
    await pushQueue(USER);

    const writes = holder.client.writes as Write[];
    expect(writes.filter((w) => w.op === 'delete')).toEqual([]);
    expect(writes).toHaveLength(1);
    const [w] = writes;
    expect(w.table).toBe(table);
    expect(w.op).toBe('update');
    expect(w.eq).toEqual(['id', id]);
    expect(Object.keys(w.row).sort()).toEqual(['deleted_at', 'updated_at']);
    expect(w.row.deleted_at).toBe(w.row.updated_at);
    expect(Number.isNaN(Date.parse(w.row.deleted_at))).toBe(false);
  });

  it('a legacy local id is tombstoned under the uuid it was pushed as', async () => {
    const legacy = 'task-1700000000000';
    await enqueue('task', legacy, 'delete', { id: legacy });
    await pushQueue(USER);
    expect((holder.client.writes as Write[])[0].eq).toEqual(['id', legacyIdToUuid(legacy)]);
  });

  it('a live edit still never sends deleted_at, so it cannot undo a delete made elsewhere', async () => {
    const id = uuid();
    await enqueue('task', id, 'update', {
      id, title: 'x', priority: 'medium', completed: false, createdAt: T0, updatedAt: T0,
    });
    await pushQueue(USER);
    const [w] = holder.client.writes as Write[];
    expect(w.op).toBe('upsert');
    expect('deleted_at' in w.row).toBe(false);
  });
});

// server table → a live row and the local table it lands in.
const serverRow: Record<string, (id: string, deleted: boolean) => any> = {
  transactions: (id, d) => ({ id, user_id: USER, amount: 5, type: 'expense', date: '2026-09-01', created_at: T0, deleted_at: d ? DELETED : null }),
  budget_categories: (id, d) => ({ id, user_id: USER, name: 'Food', monthly_limit: 100, created_at: T0, deleted_at: d ? DELETED : null }),
  tasks: (id, d) => ({ id, user_id: USER, title: 't', priority: 'normal', status: 'open', created_at: T0, updated_at: T0, deleted_at: d ? DELETED : null }),
  manual_assets: (id, d) => ({ id, user_id: USER, name: 'Bank', asset_type: 'checking', value: 10, currency: 'EUR', created_at: T0, updated_at: T0, deleted_at: d ? DELETED : null }),
  watchlist_items: (id, d) => ({ id, user_id: USER, ticker: 'ABC', name: 'Abc', asset_type: 'stock', created_at: T0, updated_at: T0, deleted_at: d ? DELETED : null }),
  goals: (id, d) => ({ id, user_id: USER, title: 'g', goal_type: 'custom', target_value: 1, start_date: '2026-09-01', completed: false, created_at: T0, updated_at: T0, deleted_at: d ? DELETED : null }),
  portfolio_lots: (id, d) => ({ id, user_id: USER, holding_id: uuid(), quantity: 1, cost_per_unit: 1, cost_currency: 'EUR', created_at: T0, updated_at: T0, deleted_at: d ? DELETED : null }),
  // v1.19 (NCC#92)
  portfolio_holdings: (id, d) => ({ id, user_id: USER, ticker: 'ABC', asset_type: 'stock', quantity: 1, created_at: T0, updated_at: T0, deleted_at: d ? DELETED : null }),
  stock_sales: (id, d) => ({ id, user_id: USER, ticker: 'ABC', shares_sold: 1, sale_price_per_share: 2, cost_basis_per_share: 1, realized_gain_loss: 1, currency: 'EUR', sold_at: T0, lot_allocations: [], created_at: T0, deleted_at: d ? DELETED : null }),
  portfolio_cash_entries: (id, d) => ({ id, user_id: USER, type: 'deposit', amount: 5, currency: 'EUR', created_at: T0, deleted_at: d ? DELETED : null }),
};
const localTable = {
  transactions: () => db.transactions,
  budget_categories: () => db.budgetCategories,
  tasks: () => db.tasks,
  manual_assets: () => db.manualAssets,
  watchlist_items: () => db.watchlistItems,
  goals: () => db.goals,
  portfolio_lots: () => db.portfolioLots,
  portfolio_holdings: () => db.portfolioHoldings,
  stock_sales: () => db.stockSales,
  portfolio_cash_entries: () => db.portfolioCashEntries,
} as const;
const TABLES = Object.keys(localTable) as (keyof typeof localTable)[];
const resultKey = {
  transactions: 'transactions',
  budget_categories: 'budgetCategories',
  tasks: 'tasks',
  manual_assets: 'manualAssets',
  watchlist_items: 'watchlistItems',
  goals: 'goals',
  portfolio_lots: 'portfolioLots',
  portfolio_holdings: 'portfolioHoldings',
  stock_sales: 'stockSales',
  portfolio_cash_entries: 'portfolioCashEntries',
} as const;

describe('pull: tombstones from another device remove the local row', () => {
  it.each(TABLES)('%s: the tombstoned row goes, the live one stays', async (table) => {
    const live = uuid();
    const gone = uuid();
    const local = localTable[table]() as any;
    await local.bulkPut([{ id: live }, { id: gone }]);
    holder.client = client({ [table]: [serverRow[table](live, false), serverRow[table](gone, true)] });

    const r = await pullAll(USER);

    expect((await local.toArray()).map((r: any) => r.id)).toEqual([live]);
    // The pull reports live rows only; a tombstone is not a row it pulled in.
    expect(r[resultKey[table]]).toBe(1);
  });

  it.each(TABLES)('%s: a tombstone is never written into a device that lacked the row', async (table) => {
    holder.client = client({ [table]: [serverRow[table](uuid(), true)] });
    await pullAll(USER);
    expect(await (localTable[table]() as any).count()).toBe(0);
  });

  it('pulls these tables without a deleted_at filter, so tombstones arrive at all', async () => {
    await pullAll(USER);
    const reqs = (holder.client.requests as any[]).filter((r) => TABLES.includes(r.table));
    expect(new Set(reqs.map((r) => r.table))).toEqual(new Set(TABLES));
    expect(reqs.every((r) => !r.filters.some(([, col]: any) => col === 'deleted_at'))).toBe(true);
  });

  it('matches a row stored under a legacy local id', async () => {
    const legacy = 'task-1700000000000';
    await db.tasks.put({ id: legacy } as any);
    holder.client = client({ tasks: [serverRow.tasks(legacyIdToUuid(legacy), true)] });
    await pullAll(USER);
    expect(await db.tasks.count()).toBe(0);
  });

  it('removes nothing when that table\'s pull fails', async () => {
    const gone = uuid();
    await db.tasks.put({ id: gone } as any);
    holder.client = client(
      { tasks: [serverRow.tasks(gone, true)] },
      { failWhen: (req) => (req.table === 'tasks' ? { code: '57014', message: 'statement timeout' } : null) },
    );
    const r = await pullAll(USER);
    expect(r.errors.some((e) => e.startsWith('tasks:'))).toBe(true);
    expect(await db.tasks.get(gone)).toBeDefined();
  });

  it('leaves a local row the server has never seen alone', async () => {
    const localOnly = uuid();
    await db.transactions.put({ id: localOnly } as any);
    holder.client = client({ transactions: [] });
    await pullAll(USER);
    expect(await db.transactions.get(localOnly)).toBeDefined();
  });

  it('still filters LimeLog\'s workout_sessions, whose deletes are limelog#32', async () => {
    await pullAll(USER);
    const req = (holder.client.requests as any[]).find((r) => r.table === 'workout_sessions');
    expect(req.filters).toContainEqual(['is', 'deleted_at', null]);
  });
});

// v1.19 (NCC#92): the portfolio tables that gained deleted_at.
describe('push: portfolio holdings, sales and cash entries are tombstoned', () => {
  it.each([
    ['portfolio_holding', 'portfolio_holdings', ['deleted_at', 'updated_at']],
    ['stock_sale', 'stock_sales', ['deleted_at']],
    ['portfolio_cash_entry', 'portfolio_cash_entries', ['deleted_at']],
  ] as const)('%s → tombstones %s', async (entityType, table, keys) => {
    const id = uuid();
    await enqueue(entityType, id, 'delete', { id });
    await pushQueue(USER);
    const writes = holder.client.writes as Write[];
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ table, op: 'update', eq: ['id', id] });
    expect(Object.keys(writes[0].row).sort()).toEqual([...keys]);
  });

  it('falls back to the hard delete while the column is not there yet (migration not applied)', async () => {
    holder.client = client({}, undefined, { code: 'PGRST204', message: "Could not find the 'deleted_at' column" });
    const id = uuid();
    await enqueue('stock_sale', id, 'delete', { id });
    await pushQueue(USER);
    const writes = holder.client.writes as Write[];
    expect(writes.map((w) => w.op)).toEqual(['update', 'delete']);
    expect(writes[1]).toMatchObject({ table: 'stock_sales', eq: ['id', id] });
    expect(await db.syncQueue.filter((q) => !q.syncedAt).count()).toBe(0);
  });

  it('does not hard-delete on any other error', async () => {
    holder.client = client({}, undefined, { code: '57014', message: 'statement timeout' });
    const id = uuid();
    await enqueue('portfolio_holding', id, 'delete', { id });
    await pushQueue(USER);
    expect((holder.client.writes as Write[]).some((w) => w.op === 'delete')).toBe(false);
  });
});
