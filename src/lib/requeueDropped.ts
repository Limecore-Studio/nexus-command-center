// NCC#55 — put back the queue items the manual_assets CHECK made us drop.
//
// v1.2.0 introduced the account types checking, credit_card, investment and
// custom, but `manual_assets_asset_type_check` still allowed only the
// pre-v1.2 set. Every such account was refused with 23514, and every
// transaction booked to it then failed `transactions_account_id_fkey`
// (23503). pushQueue classes both as permanent and marks the item synced with
// a `[dropped]` error, so none of them ever reached the server — 0 checking,
// credit-card or investment accounts exist there.
//
// Pushed items were never pruned before v1.22, and the newest revivable one
// of an entity still is not (selectPrunable), so dropped
// items are still on the device. Once the constraint accepts the new types
// (supabase/migrations/20260924_manual_assets_account_types.sql) they can be
// pushed as they are. This module picks which ones; it has no I/O so it can be
// checked without a database.

import type { SyncQueueItem } from '../db/database';

export const REQUEUE_TAG = 'ncc-55';

const REVIVABLE: Partial<Record<SyncQueueItem['entityType'], RegExp>> = {
  manual_asset: /manual_assets_asset_type_check/,
  transaction: /transactions_account_id_fkey/,
};

/**
 * Items to put back in the queue: per entity, only the NEWEST item, only when
 * it was dropped for one of the two reasons above, only if it is not a delete,
 * and only once (`requeuedFor`). Anything newer for the same entity — pending
 * or pushed — means the dropped snapshot is stale and must not overwrite it.
 */
export function selectRequeue(items: SyncQueueItem[]): SyncQueueItem[] {
  const newest = new Map<string, SyncQueueItem>();
  for (const it of items) {
    if (!(it.entityType in REVIVABLE)) continue;
    const key = `${it.entityType}::${it.entityId}`;
    const cur = newest.get(key);
    if (!cur || it.createdAt > cur.createdAt) newest.set(key, it);
  }
  const out: SyncQueueItem[] = [];
  for (const it of newest.values()) {
    const why = REVIVABLE[it.entityType];
    if (!why || it.operation === 'delete') continue;
    if (!it.syncedAt || it.requeuedFor === REQUEUE_TAG) continue;
    const err = it.lastError ?? '';
    if (!err.startsWith('[dropped]') || !why.test(err)) continue;
    out.push(it);
  }
  return out;
}

// v1.22 (NCC#249): pushed items were kept forever, and every pull and drain
// reads the whole queue, so it grew with each edit, import row and recurring
// occurrence. Pushed items older than this are deleted.
export const PRUNE_AFTER_DAYS = 14;

/**
 * Pushed items (`syncedAt` set) older than `cutoff` that can go. Pending items
 * always stay. One pushed item may also stay: the newest item of an entity
 * that selectRequeue could still put back (dropped for a reason it revives,
 * not yet requeued). selectRequeue only looks at an entity's newest item, so
 * deleting the newer ones while keeping an older dropped one would make that
 * stale snapshot "newest" and revive it. Here an entity's older items go, and
 * its newest stays only if it is itself revivable.
 */
export function selectPrunable(items: SyncQueueItem[], cutoff: string): SyncQueueItem[] {
  const keep = new Set(selectRequeue(items).map((it) => it.id));
  return items.filter((it) => it.syncedAt && it.syncedAt < cutoff && !keep.has(it.id));
}
