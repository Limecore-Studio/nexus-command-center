import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Dexie from 'dexie';

// `database.ts` imports `clearEntitlement` (used only inside
// `clearAllLocalData`), and that one import pulls in `lib/supabase`, which
// evaluates `window.location.origin` at module scope. Stubbing the seam keeps
// this a storage-layer test instead of dragging a Supabase client and a DOM
// into it. The coupling itself is worth revisiting in the code-health pass
// (limecore#12) — a Dexie schema file should not transitively construct a
// network client.
vi.mock('../lib/entitlement', () => ({ clearEntitlement: vi.fn() }));

// v1.16, issue #45 + limecore#11.
//
// `deleteBudgetCategory` has queried `transactions.where('categoryId')` since
// v1.3.3, but `categoryId` was never declared as an index, so every category
// delete threw `KeyPath categoryId on object store transactions is not
// indexed`. Dexie v23 adds the index. The thing that actually has to be true
// for shipped installs is that rows written BEFORE the index existed show up in
// it afterwards — IndexedDB is supposed to backfill an index when it is
// created, and this test is here so that is a verified property rather than an
// assumption about the storage engine.
//
// The fixture opens the real database name at the previous version, writes
// v1.15-shaped rows, closes it, and only then lets the shipped schema upgrade
// it — the same sequence a user's device performs on first launch after update.

const DB_NAME = 'nexus_dashboard';

const OLD_CATEGORY_ID = 'cat-old-1';
const OTHER_CATEGORY_ID = 'cat-old-2';

async function seedPreUpgradeDatabase() {
  // The v22 index list for `transactions`, exactly as shipped in v1.15:
  // no `categoryId`.
  const old = new Dexie(DB_NAME);
  old.version(22).stores({
    transactions: 'id, date, type, syncStatus, accountId',
    budgetCategories: 'id, name',
  });
  await old.open();
  await old.table('transactions').bulkAdd([
    { id: 'tx-1', date: '2026-01-05', type: 'expense', amount: 3.5, description: 'Coffee', categoryId: OLD_CATEGORY_ID, syncStatus: 'synced' },
    { id: 'tx-2', date: '2026-01-06', type: 'expense', amount: 9.0, description: 'Lunch', categoryId: OLD_CATEGORY_ID, syncStatus: 'synced' },
    { id: 'tx-3', date: '2026-01-07', type: 'expense', amount: 2.0, description: 'Bus', categoryId: OTHER_CATEGORY_ID, syncStatus: 'synced' },
    // A transaction with no category at all — must stay out of the index
    // rather than landing under some coerced key.
    { id: 'tx-4', date: '2026-01-08', type: 'income', amount: 100, description: 'Refund', syncStatus: 'synced' },
  ]);
  await old.table('budgetCategories').bulkAdd([
    { id: OLD_CATEGORY_ID, name: 'Food', monthlyLimit: 200 },
    { id: OTHER_CATEGORY_ID, name: 'Transport', monthlyLimit: 50 },
  ]);
  old.close();
}

describe('Dexie v23 upgrade from v1.15 data (issue #45)', () => {
  let db: typeof import('./database').db;

  beforeAll(async () => {
    await Dexie.delete(DB_NAME);
    await seedPreUpgradeDatabase();
    // Imported only now, so the module-level singleton opens against the
    // already-seeded database and performs a real upgrade.
    ({ db } = await import('./database'));
    await db.open();
  });

  afterAll(async () => {
    db?.close();
    await Dexie.delete(DB_NAME);
  });

  // v1.19 (NCC#202): v24 adds recurringRules; the v23 index still applies.
  it('upgrades to the latest schema version (24)', () => {
    expect(db.verno).toBe(24);
  });

  it('declares categoryId as an index on transactions', () => {
    const indexes = db.table('transactions').schema.indexes.map((i) => i.name);
    expect(indexes).toContain('categoryId');
  });

  it('keeps every pre-upgrade row', async () => {
    expect(await db.transactions.count()).toBe(4);
  });

  it('backfills the new index with rows written before it existed', async () => {
    // The actual regression guard. Before v23 this threw; a storage engine that
    // did not backfill would return an empty array instead, which would make
    // category deletion silently orphan every historical transaction.
    const hits = await db.transactions.where('categoryId').equals(OLD_CATEGORY_ID).toArray();
    expect(hits.map((t) => t.id).sort()).toEqual(['tx-1', 'tx-2']);
  });

  it('does not match transactions belonging to a different category', async () => {
    const hits = await db.transactions.where('categoryId').equals(OTHER_CATEGORY_ID).toArray();
    expect(hits.map((t) => t.id)).toEqual(['tx-3']);
  });

  it('leaves a transaction with no categoryId out of the index entirely', async () => {
    const keys = await db.transactions.orderBy('categoryId').keys();
    expect(keys).not.toContain(undefined);
    expect(keys).toHaveLength(3);
  });

  it('drops a row back out of the index when its categoryId is cleared', async () => {
    // This is what deleteBudgetCategory does to each affected row.
    const tx = await db.transactions.get('tx-1');
    await db.transactions.put({ ...tx!, categoryId: undefined });
    const hits = await db.transactions.where('categoryId').equals(OLD_CATEGORY_ID).toArray();
    expect(hits.map((t) => t.id)).toEqual(['tx-2']);
    // Restore so test order cannot matter.
    await db.transactions.put({ ...tx! });
  });
});
