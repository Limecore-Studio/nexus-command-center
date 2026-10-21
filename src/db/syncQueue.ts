import { db, SyncQueueItem } from './database';
import { generateId } from '../utils/uuid';
import { stampFor } from '../lib/editStamp';

// v1.18.1 (limecore#59 §2, NCC#140) — whose edits are being queued: the
// signed-in user's id, null as a guest, undefined until the session is known.
// Set by useSessionStore. Every item records it, and pushQueue sends only the
// current user's: a guest's edits used to go up under whoever signed in next,
// a second or two after sign-in and before the "Existing data found" choice
// (so Discard could not take them back); and a session that ended without a
// sign-out left its queue to drain under the next account.
let queueOwner: string | null | undefined;

export function setQueueOwner(userId: string | null): void {
  queueOwner = userId;
}

/** NCC#172 — items queued by v1.18.0 or older carry no owner, so any account
 *  could push them. Called once, at the first known session of a launch: they
 *  go to whoever that is (null as a guest, so they wait for "Keep"). Older
 *  builds cleared unsynced items at every sign-out, so what is left was almost
 *  always made in the session that is still open, or as a guest. (Not always:
 *  a session that ended without a sign-out left its items for the next one,
 *  which then pushed them anyway, so this is no worse than before.) */
export async function claimUnowned(owner: string | null): Promise<void> {
  await db.syncQueue.filter((q) => !q.syncedAt && q.owner === undefined).modify({ owner });
}

/** May `userId` push this item? Its own, and items from older builds (no
 *  owner recorded) as before. A guest's (null) wait for "Keep" on the
 *  "Existing data found" prompt (adoptLocalData); another account's wait
 *  for that account. */
export function pushableFor(item: Pick<SyncQueueItem, 'owner'>, userId: string): boolean {
  return item.owner === undefined || item.owner === userId;
}

export async function enqueue(
  entityType: SyncQueueItem['entityType'],
  entityId: string,
  operation: SyncQueueItem['operation'],
  payload: unknown
): Promise<void> {
  await db.syncQueue.add({
    id: generateId(),
    entityType,
    entityId,
    operation,
    payload: JSON.stringify(payload),
    createdAt: new Date().toISOString(),
    // v1.16 (limecore#27, registry P6): stamped here, at the edit — never at
    // push time, when a later pull could lift a stale edit past a newer one.
    stamp: stampFor(entityType, entityId, operation),
    ...(queueOwner !== undefined ? { owner: queueOwner } : {}),
  });
}

export async function listPending(): Promise<SyncQueueItem[]> {
  const all = await db.syncQueue.toArray();
  return all.filter((q) => !q.syncedAt);
}

/** The pending items the current queue owner would push: the sync chip's and
 *  Settings' count, and what the 30 s flusher waits on. Another account's
 *  kept edits are not this user's backlog. */
export async function listOwnPending(): Promise<SyncQueueItem[]> {
  const u = queueOwner;
  return (await listPending()).filter((q) => u === undefined || (u ? pushableFor(q, u) : q.owner == null));
}

/** Edits made as a guest and not yet released by "Keep" (adoptLocalData). */
export async function hasGuestEdits(): Promise<boolean> {
  return (await listPending()).some((q) => q.owner === null);
}

