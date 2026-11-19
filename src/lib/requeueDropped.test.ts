import { describe, it, expect } from 'vitest';
import type { SyncQueueItem } from '../db/database';
import { selectPrunable, selectRequeue, REQUEUE_TAG } from './requeueDropped';

// v1.22 (NCC#249): pushed queue items are pruned once they are old, without
// changing what the NCC#55 rescue (selectRequeue) would put back.

const OLD = '2026-01-01T00:00:00.000Z';
const CUTOFF = '2026-06-01T00:00:00.000Z';
const NEW = '2026-11-01T00:00:00.000Z';

let n = 0;
function item(p: Partial<SyncQueueItem>): SyncQueueItem {
  n++;
  return {
    id: `q${n}`,
    entityType: 'transaction',
    entityId: 'e1',
    operation: 'update',
    payload: '{}',
    createdAt: `2026-01-01T00:00:${String(n).padStart(2, '0')}.000Z`,
    ...p,
  } as SyncQueueItem;
}

const dropped = (p: Partial<SyncQueueItem> = {}) =>
  item({ entityType: 'manual_asset', syncedAt: OLD, lastError: '[dropped] violates manual_assets_asset_type_check', ...p });

describe('selectPrunable', () => {
  it('deletes old pushed items, keeps recent pushed and every pending one', () => {
    const old = item({ syncedAt: OLD });
    const recent = item({ syncedAt: NEW });
    const pending = item({});
    const failing = item({ lastError: 'network' });
    expect(selectPrunable([old, recent, pending, failing], CUTOFF).map((i) => i.id)).toEqual([old.id]);
  });

  it('keeps an entity’s newest item while the rescue could still revive it', () => {
    const older = item({ entityType: 'manual_asset', syncedAt: OLD });
    const d = dropped();
    expect(selectRequeue([older, d]).map((i) => i.id)).toEqual([d.id]);
    expect(selectPrunable([older, d], CUTOFF).map((i) => i.id)).toEqual([older.id]);
  });

  it('never leaves a stale dropped snapshot behind as the newest item', () => {
    const d = dropped();
    const newer = item({ entityType: 'manual_asset', syncedAt: OLD });
    // The newer push makes the dropped one stale; both may go, and nothing is
    // left for the rescue to revive.
    const pruned = selectPrunable([d, newer], CUTOFF);
    expect(pruned.map((i) => i.id).sort()).toEqual([d.id, newer.id].sort());
    expect(selectRequeue([d, newer].filter((i) => !pruned.includes(i)))).toEqual([]);
  });

  it('an item already rescued once is ordinary history', () => {
    const d = dropped({ requeuedFor: REQUEUE_TAG });
    expect(selectPrunable([d], CUTOFF).map((i) => i.id)).toEqual([d.id]);
  });
});
