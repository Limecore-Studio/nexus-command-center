// v1.16 (limecore#27, registry P6) — an edit is stamped
//
//     max(deviceNow, lastSeenServerStamp + 1 ms)
//
// NCC already stamped the moment of the EDIT (a queue item's `createdAt` is
// taken when the edit is enqueued), which is the heart of the rule. What it
// lacked is the `+ 1 ms` half: on a device whose clock runs a few seconds slow,
// an edit to a row it had just pulled was stamped OLDER than that row, and the
// server's last-writer-wins guard declined it — silently, since a declined
// write is a no-op, not an error.
//
// The stamp is computed at ENQUEUE, never at push. At push time `lastSeen` may
// include a pull that happened after the edit, and bumping a stale edit past
// a newer remote version is exactly the limecore#27 bug.
//
// `lastSeen` is fed by every pull and by this device's own stamps. Memory
// only: after a restart it refills on the first pull, and until then an edit
// is stamped with the plain clock — NCC's behaviour before this file.

import { legacyIdToUuid } from '../utils/uuid';

/** Queue entity types whose push writes `updated_at`, and their table. */
const ENTITY_TABLE: Partial<Record<string, string>> = {
  transaction: 'transactions',
  budget_category: 'budget_categories',
  portfolio_holding: 'portfolio_holdings',
  portfolio_lot: 'portfolio_lots',
  manual_asset: 'manual_assets',
  watchlist_item: 'watchlist_items',
  goal: 'goals',
  task: 'tasks',
  course: 'subjects',
  grade: 'grades',
  braindump_entry: 'braindump_entries',
  work_quality_log: 'work_quality_logs',
  recurring_rule: 'recurring_rules',
};

const lastSeen = new Map<string, number>();

const ms = (iso: string | null | undefined) => (iso ? new Date(iso).getTime() : NaN);
const keyOf = (table: string, id: string) => `${table}:${legacyIdToUuid(id)}`;

function remember(key: string, at: number) {
  if (!Number.isFinite(at)) return;
  const prev = lastSeen.get(key);
  if (prev === undefined || at > prev) lastSeen.set(key, at);
}

/** Record the stamps a pull returned for one table. */
export function recordSeen(table: string, rows: readonly { id?: string; updated_at?: string | null }[]): void {
  for (const r of rows) {
    if (r?.id) remember(keyOf(table, r.id), ms(r.updated_at));
  }
}

/**
 * The stamp for an edit being enqueued now, or undefined for a delete or an
 * entity type that writes no `updated_at`. Records the result, so the next
 * edit of the same row is newer again even if the clock steps backwards.
 */
export function stampFor(
  entityType: string,
  entityId: string,
  operation: 'insert' | 'update' | 'delete',
  now: number = Date.now(),
): string | undefined {
  const table = ENTITY_TABLE[entityType];
  if (!table || operation === 'delete' || !entityId) return undefined;
  const key = keyOf(table, entityId);
  const seen = lastSeen.get(key);
  const at = seen !== undefined && now <= seen ? seen + 1 : now;
  remember(key, at);
  return new Date(at).toISOString();
}

/** What a push sends as `updated_at`. The item's own stamp when it has one;
 *  for an item queued by an older build, exactly the expression the push
 *  used before — the entity's `updatedAt`, else the enqueue time. */
export function stampOf(item: { stamp?: string; createdAt: string }, local?: { updatedAt?: string }): string {
  return item.stamp || local?.updatedAt || item.createdAt;
}

/** Test seam. */
export function resetEditStamps(): void {
  lastSeen.clear();
}
