import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Dexie from 'dexie';

// See database.test.ts for why this seam is stubbed.
vi.mock('../lib/entitlement', () => ({ clearEntitlement: vi.fn() }));

// v1.16, limecore#7.
//
// "Sign out and wipe local data" is the option offered for a shared or
// borrowed device, so a table it silently misses is a stranger's personal data
// left on someone else's phone. The wipe list in `clearAllLocalData` is
// hand-maintained and 28 entries long, which is exactly the shape of thing
// that drifts the first time a store is added and the list is not. Asserting
// against `db.tables` rather than a copy of the list means a new store fails
// here instead of shipping.
//
// Kept in its own file because the assertion destroys every fixture row, and
// a Dexie singleton is shared for the whole file it lives in.

describe('clearAllLocalData', () => {
  let db: typeof import('./database').db;
  let clearAllLocalData: typeof import('./database').clearAllLocalData;

  beforeAll(async () => {
    await Dexie.delete('nexus_dashboard');
    ({ db, clearAllLocalData } = await import('./database'));
    await db.open();
  });

  afterAll(async () => {
    db?.close();
    await Dexie.delete('nexus_dashboard');
  });

  it('leaves no row in any declared table', async () => {
    const names = db.tables.map((t) => t.name);
    expect(names.length).toBeGreaterThan(20);

    // One probe row per store. Primary keys differ across this schema
    // (`id`, `cacheKey`, and one auto-incrementing number), so the probe
    // carries every shape and stores that reject it are counted, not assumed.
    await Promise.all(
      names.map((n) =>
        db
          .table(n)
          .put({ id: `probe-${n}`, cacheKey: `probe-${n}`, date: '2026-01-01' })
          .catch(() => undefined),
      ),
    );

    const before = await Promise.all(
      names.map(async (n) => [n, await db.table(n).count()] as const),
    );
    const seeded = before.filter(([, c]) => c > 0).map(([n]) => n);
    // If this ever drops sharply, the probe stopped fitting the schema and the
    // test would start passing vacuously.
    expect(seeded.length).toBeGreaterThanOrEqual(names.length - 2);

    await clearAllLocalData();

    const after = await Promise.all(
      names.map(async (n) => [n, await db.table(n).count()] as const),
    );
    expect(after.filter(([, c]) => c > 0)).toEqual([]);
  });

  // v1.18.1 — after Discard, the next account must not inherit the previous
  // person's life profile or onboarded flag (both back-fill into its cloud)
  // or their manual fitness values. Device settings stay.
  it('removes the per-person values kept outside Dexie, and keeps device settings', async () => {
    const personal = ['ncc.lifeProfile', 'ncc.onboarded', 'nexus.referralAsked', 'fitness.manualWeightKg', 'fitness.manualSteps', 'fitness.stepHistory'];
    const device = ['nexus.theme', 'limecore_lang', 'settings.baseCurrency', 'settings.notif.master'];
    for (const k of [...personal, ...device]) localStorage.setItem(k, 'x');
    await clearAllLocalData();
    for (const k of personal) expect(localStorage.getItem(k), k).toBeNull();
    for (const k of device) expect(localStorage.getItem(k), k).toBe('x');
  });
});
