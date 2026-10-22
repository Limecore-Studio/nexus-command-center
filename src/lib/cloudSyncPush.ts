// Push mappers: one function per syncQueue entity type, each turning a
// queued local edit into the Supabase write for it. Drained in order by
// pushQueue() in cloudSync.ts. Moved out of cloudSync.ts unchanged (limecore#12).
import { supabase } from './supabase';
import { stampOf } from './editStamp';
import { db, SyncQueueItem } from '../db/database';
import { legacyIdToUuid } from '../utils/uuid';
import type { Transaction, BudgetCategory, PortfolioHolding, PortfolioLot, ManualAsset, WatchlistItem, StockSale, PortfolioCashEntry } from '../types/finance';
import { isManuallyPriced } from '../types/finance';
import type { CoursePushPayload, Grade } from '../types/studies';
import type { Task, TaskPriority } from '../types/tasks';
import type { Goal } from '../types/goals';
import type { Habit, HabitCompletion } from '../types/habits';
import type { WorkQualityLog } from '../types/work';
import type { BraindumpEntry } from '../types/braindump';
import type { RecurringRule } from '../types/recurring';
import { dueAtForServer, dueLocalDate } from './taskDue';

// ============================================================================
// Push mappers — local entity → remote upsert payload
// ============================================================================

function mapTaskPriority(p: TaskPriority): 'low' | 'normal' | 'high' | 'urgent' {
  if (p === 'medium') return 'normal';
  return p;
}

function mapTaskStatus(completed: boolean): 'open' | 'done' {
  return completed ? 'done' : 'open';
}

interface PushContext {
  userId: string;
}

/**
 * v1.16 (NCC#56 part 2, registry P6) — delete by writing a tombstone, never
 * by `DELETE`. A hard delete left no trace, so a second NCC device (phone plus
 * web, say) never learned of it: the row lived on there, and the next edit on
 * that device re-created it upstream. A tombstone reaches every device through
 * `pullAll`, and the server's guard lets it land whatever its stamp while a
 * later content edit, which never sends `deleted_at`, cannot un-delete it.
 * `purge_soft_deleted()` hard-deletes the tombstone after 90 days.
 *
 * Only for tables that have `deleted_at` AND are in that purge. The children
 * a hard delete used to cascade to or null out now stay until the purge:
 * `transactions.category_id` is cleared by deleteBudgetCategory itself;
 * a deleted account's transactions keep their `account_id`, as they already
 * did on the device that deleted it; shares of a deleted task or category
 * stay, and their grantee's pull removes the tombstoned row.
 */
async function softDelete(table: string, entityId: string): Promise<void> {
  const stamp = new Date().toISOString();
  const { error } = await supabase
    .from(table)
    .update({ deleted_at: stamp, updated_at: stamp })
    .eq('id', legacyIdToUuid(entityId));
  if (error) throw error;
}

/**
 * v1.19 (NCC#92) — softDelete for the portfolio tables that gained
 * `deleted_at` in 20261022_portfolio_tombstones.sql. `stamped` is false for
 * stock_sales and portfolio_cash_entries, which have no `updated_at`. Until
 * that migration is applied the column is unknown (PostgREST PGRST204,
 * Postgres 42703), and the delete falls back to the hard delete of old.
 */
async function softDeleteOrHard(table: string, entityId: string, stamped: boolean): Promise<void> {
  const stamp = new Date().toISOString();
  const id = legacyIdToUuid(entityId);
  const { error } = await supabase
    .from(table)
    .update(stamped ? { deleted_at: stamp, updated_at: stamp } : { deleted_at: stamp })
    .eq('id', id);
  if (!error) return;
  if (error.code !== 'PGRST204' && error.code !== '42703') throw error;
  const hard = await supabase.from(table).delete().eq('id', id);
  if (hard.error) throw hard.error;
}

/**
 * v1.19 (NCC#202) — the upsert for a row a recurring rule may have generated.
 * The row carries `recurring_rule_id`. Its FIRST write (the queued insert)
 * ignores a row already there: another device may have materialised the same
 * occurrence (same deterministic id) and the user may have edited or deleted
 * it since, which a second insert must not undo. Later edits are ordinary
 * last-writer-wins upserts.
 */
async function upsertMaybeGenerated(
  table: string,
  row: Record<string, unknown>,
  item: SyncQueueItem,
  ruleId: string | undefined,
): Promise<void> {
  if (!ruleId) {
    const { error } = await supabase.from(table).upsert(row);
    if (error) throw error;
    return;
  }
  const withRule = { ...row, recurring_rule_id: legacyIdToUuid(ruleId) };
  const { error } = item.operation === 'insert'
    ? await supabase.from(table).upsert(withRule, { onConflict: 'id', ignoreDuplicates: true })
    : await supabase.from(table).upsert(withRule);
  if (error) throw error;
}

async function pushTransaction(item: SyncQueueItem, ctx: PushContext): Promise<void> {
  if (item.operation === 'delete') {
    await softDelete('transactions', item.entityId);
    return;
  }
  const local: Transaction = JSON.parse(item.payload);
  const type = local.type === 'transfer' ? 'expense' : local.type;
  const description =
    local.type === 'transfer' && local.description
      ? `[transfer] ${local.description}`
      : local.description;
  const row = {
    id: legacyIdToUuid(local.id),
    user_id: ctx.userId,
    amount: local.amount,
    currency: 'EUR',
    type,
    category_id: local.categoryId ? legacyIdToUuid(local.categoryId) : null,
    // v1.3.3 — account assignment is now persisted to the cloud (was local-only),
    // so it survives a "keep local data" sign-out and syncs across devices.
    account_id: local.accountId ? legacyIdToUuid(local.accountId) : null,
    destination_account_id: local.destinationAccountId ? legacyIdToUuid(local.destinationAccountId) : null,
    description,
    date: local.date,
    updated_at: stampOf(item),
  };
  await upsertMaybeGenerated('transactions', row, item, local.recurringRuleId);
}

async function pushBudgetCategory(item: SyncQueueItem, ctx: PushContext): Promise<void> {
  if (item.operation === 'delete') {
    await softDelete('budget_categories', item.entityId);
    return;
  }
  const local: BudgetCategory = JSON.parse(item.payload);
  const row = {
    id: legacyIdToUuid(local.id),
    user_id: ctx.userId,
    name: local.name,
    monthly_limit: local.monthlyLimit,
    currency: 'EUR',
    color: local.icon ?? null,
    updated_at: stampOf(item),
  };
  const { error } = await supabase.from('budget_categories').upsert(row);
  if (error) throw error;
}

async function pushPortfolioHolding(item: SyncQueueItem, ctx: PushContext): Promise<void> {
  if (item.operation === 'delete') {
    // v1.19 (NCC#92): a tombstone. deleteHolding queues its lots' deletes
    // too, so nothing relies on the FK cascade any more.
    await softDeleteOrHard('portfolio_holdings', item.entityId, true);
    return;
  }
  const local: PortfolioHolding = JSON.parse(item.payload);
  const row = {
    id: legacyIdToUuid(local.id),
    user_id: ctx.userId,
    asset_type: local.assetType,
    ticker: local.ticker,
    name: local.name ?? null,
    quantity: local.quantity,
    avg_cost_native: local.avgCostNative ?? null,
    cost_currency: local.costCurrency ?? null,
    sector_override: local.sectorOverride ?? null,
    updated_at: stampOf(item),
    // v1.19 (NCC#204): the price and terms of a bond / custom holding. Sent
    // for those types only, so every other holding's push stays the same.
    ...(isManuallyPriced(local.assetType)
      ? {
          manual_price: local.manualPrice ?? null,
          manual_price_currency: local.manualPriceCurrency ?? null,
          manual_price_at: local.manualPriceAt ?? null,
          bond_terms: local.assetType === 'bond' ? local.bond ?? null : null,
        }
      : {}),
  };
  const { error } = await supabase.from('portfolio_holdings').upsert(row);
  if (error) throw error;
}

async function pushPortfolioLot(item: SyncQueueItem, ctx: PushContext): Promise<void> {
  if (item.operation === 'delete') {
    await softDelete('portfolio_lots', item.entityId);
    return;
  }
  const local: PortfolioLot = JSON.parse(item.payload);
  const updatedAt = stampOf(item, local);
  const row = {
    id: legacyIdToUuid(local.id),
    user_id: ctx.userId,
    holding_id: legacyIdToUuid(local.holdingId),
    quantity: local.quantity,
    cost_per_unit: local.costPerUnit,
    cost_currency: local.costCurrency,
    purchase_date: local.purchaseDate ?? null,
    notes: local.notes ?? null,
    updated_at: updatedAt,
  };
  await upsertMaybeGenerated('portfolio_lots', row, item, local.recurringRuleId);
}

// v1.3.1 (BUG-23) — realized stock sale. Append-only on the cloud; removal is
// a tombstone from v1.19 (NCC#92). The
// per-lot soldShares is NOT pushed (the cloud portfolio_lots table has no such
// column); it's derived on every device from these sales' lot_allocations.
async function pushStockSale(item: SyncQueueItem, ctx: PushContext): Promise<void> {
  if (item.operation === 'delete') {
    await softDeleteOrHard('stock_sales', item.entityId, false);
    return;
  }
  const local: StockSale = JSON.parse(item.payload);
  const row = {
    id: legacyIdToUuid(local.id),
    user_id: ctx.userId,
    ticker: local.ticker,
    holding_id: local.holdingId ? legacyIdToUuid(local.holdingId) : null,
    shares_sold: local.sharesSold,
    sale_price_per_share: local.salePricePerShare,
    cost_basis_per_share: local.costBasisPerShare,
    realized_gain_loss: local.realizedGainLoss,
    currency: local.currency,
    sold_at: local.soldAt,
    lot_allocations: local.lotAllocations,
    created_at: local.createdAt,
  };
  const { error } = await supabase.from('stock_sales').upsert(row);
  if (error) throw error;
}

// v1.3.2 — portfolio cash ledger entry. A tombstone on removal from v1.19
// (NCC#92), same as stock_sales — the table is a personal append-only ledger.
async function pushPortfolioCashEntry(item: SyncQueueItem, ctx: PushContext): Promise<void> {
  if (item.operation === 'delete') {
    await softDeleteOrHard('portfolio_cash_entries', item.entityId, false);
    return;
  }
  const local: PortfolioCashEntry = JSON.parse(item.payload);
  const row = {
    id: legacyIdToUuid(local.id),
    user_id: ctx.userId,
    type: local.type,
    amount: local.amount,
    currency: local.currency,
    account_id: local.accountId ? legacyIdToUuid(local.accountId) : null,
    related_id: local.relatedId ? legacyIdToUuid(local.relatedId) : null,
    note: local.note ?? null,
    created_at: local.createdAt,
  };
  await upsertMaybeGenerated('portfolio_cash_entries', row, item, local.recurringRuleId);
}

async function pushManualAsset(item: SyncQueueItem, ctx: PushContext): Promise<void> {
  if (item.operation === 'delete') {
    await softDelete('manual_assets', item.entityId);
    return;
  }
  const local: ManualAsset = JSON.parse(item.payload);
  const updatedAt = stampOf(item, local);
  const row = {
    id: legacyIdToUuid(local.id),
    user_id: ctx.userId,
    name: local.name,
    asset_type: local.assetType,
    value: local.value,
    currency: local.currency,
    notes: local.notes ?? null,
    updated_at: updatedAt,
  };
  const { error } = await supabase.from('manual_assets').upsert(row);
  if (error) throw error;
}

async function pushWatchlistItem(item: SyncQueueItem, ctx: PushContext): Promise<void> {
  if (item.operation === 'delete') {
    await softDelete('watchlist_items', item.entityId);
    return;
  }
  const local: WatchlistItem = JSON.parse(item.payload);
  const updatedAt = stampOf(item, local);
  const row = {
    id: legacyIdToUuid(local.id),
    user_id: ctx.userId,
    ticker: local.ticker,
    name: local.name,
    asset_type: local.assetType,
    notes: local.notes ?? null,
    target_above: local.targetAbove ?? null,
    target_below: local.targetBelow ?? null,
    updated_at: updatedAt,
  };
  const { error } = await supabase.from('watchlist_items').upsert(row);
  if (error) throw error;
}

async function pushGoal(item: SyncQueueItem, ctx: PushContext): Promise<void> {
  if (item.operation === 'delete') {
    // Soft-delete: write a tombstone row so other devices learn about it.
    const { error } = await supabase
      .from('goals')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', legacyIdToUuid(item.entityId));
    if (error) throw error;
    return;
  }
  const local: Goal = JSON.parse(item.payload);
  const updatedAt = stampOf(item, local);
  const row = {
    id: legacyIdToUuid(local.id),
    user_id: ctx.userId,
    title: local.title,
    goal_type: local.goalType,
    target_value: local.targetValue,
    target_date: local.targetDate ?? null,
    start_date: local.startDate,
    exercise_name: local.exerciseName ?? null,
    currency: local.currency ?? null,
    completed: local.completed,
    completed_at: local.completedAt ?? null,
    updated_at: updatedAt,
    // v1.16 (limecore#27, registry P6): `deleted_at` only when the goal IS
    // deleted. Sending `deleted_at: null` for every live edit made each one an
    // explicit revival, so an edit from a device that had not yet seen a
    // delete made elsewhere would bring the goal back. NCC has no deliberate
    // goal un-delete, so a live edit leaves the column alone.
    ...(local.deletedAt ? { deleted_at: local.deletedAt } : {}),
  };
  const { error } = await supabase.from('goals').upsert(row);
  if (error) throw error;
}

async function pushTask(item: SyncQueueItem, ctx: PushContext): Promise<void> {
  if (item.operation === 'delete') {
    await softDelete('tasks', item.entityId);
    return;
  }
  const local: Task = JSON.parse(item.payload);
  // Prefer the entity's own updatedAt if set (captures the actual edit moment),
  // fall back to the queue createdAt.
  const updatedAt = stampOf(item, local);
  const row = {
    id: legacyIdToUuid(local.id),
    user_id: ctx.userId,
    title: local.title,
    description: local.notes ?? null,
    status: mapTaskStatus(local.completed),
    priority: mapTaskPriority(local.priority),
    // v1.18.1 (NCC#193) - the local calendar day, plus the full instant in
    // due_at. Sending the instant as due_date kept only its UTC day, and the
    // time was lost on the next pull.
    due_date: local.dueDate ? dueLocalDate(local.dueDate) : null,
    due_at: local.dueDate ? dueAtForServer(local.dueDate) : null,
    updated_at: updatedAt,
  };
  const { error } = await supabase.from('tasks').upsert(row);
  if (error) throw error;
}

async function pushCourse(item: SyncQueueItem, ctx: PushContext): Promise<void> {
  // Local Course = subject only. Grades live in their own table now (since
  // v1.0.3), pushed via pushGrade below.
  if (item.operation === 'delete') {
    // NCC#57 — soft delete, exactly as StudyDesk's deleteSubject does. A hard
    // DELETE cascaded server-side through assignments, exams and attachments
    // with no tombstone, so StudyDesk never learned of it: its reconcile saw
    // the course missing and re-uploaded it with its children, and the course
    // came back here on the next pull. study_actions are left alone, as in
    // StudyDesk (a to-do keeps a dangling course tag rather than vanishing).
    const uuid = legacyIdToUuid(item.entityId);
    const stamp = new Date().toISOString();
    const tomb = { deleted_at: stamp, updated_at: stamp };
    for (const table of ['grades', 'assignments', 'exams'] as const) {
      const { error: childErr } = await supabase.from(table).update(tomb).eq('subject_id', uuid);
      if (childErr) throw childErr;
    }
    const { error } = await supabase.from('subjects').update(tomb).eq('id', uuid);
    if (error) throw error;
    return;
  }
  const local: CoursePushPayload = JSON.parse(item.payload);
  const uuid = legacyIdToUuid(local.id);
  const archivedAt = local.archivedAt ?? null;
  // v1.18.1 (NCC#180) — an archive/restore and nothing else: archived_at only,
  // never the rest of the row (a stale copy's name/credits would ride along).
  if (local.archiveEditedAt && local.archiveOnly) {
    await pushCourseArchiveOnly(item, uuid, archivedAt, local.archiveEditedAt);
    return;
  }
  // v1.18.1 (NCC#180) — `archived_at` is no longer part of the content write.
  // It used to ride on every course write (`archived_at: local.archivedAt ??
  // null`), so an edit made on a copy that had not yet seen an archive/restore
  // done in StudyDesk put the stale state back, re-archiving or un-archiving
  // the course everywhere; the server cannot tell a stale value from a
  // deliberate one (20261016_archive_edit_stamp.sql only catches a write
  // stamped OLDER than the archive). PostgREST's upsert is INSERT … ON
  // CONFLICT (id) DO UPDATE SET <only the columns sent>, so an existing row
  // keeps its archived_at and a new row gets the column default (NULL =
  // active). The archive is sent only by the two paths below.
  const subjectRow = {
    id: uuid,
    user_id: ctx.userId,
    name: local.name,
    credits: local.credits,
    semester: local.semester ?? null,
    color: local.color ?? null,
    updated_at: stampOf(item),
  };
  // v1.18.1 (NCC#180) — an insert of a course this device holds as archived
  // (adoptLocalData re-queues every local course as an insert, and one the
  // server has never seen would otherwise land active). ON CONFLICT DO
  // NOTHING: an existing row, whose archive may be newer than ours, is left
  // alone, and the merge upsert below then writes only the content. No
  // archived_edited_at is sent, so this works without the 20261016 migration;
  // with it, the INSERT trigger stamps the archive from updated_at.
  if (item.operation === 'insert' && local.archivedAt) {
    const { error: bornErr } = await supabase
      .from('subjects')
      .upsert({ ...subjectRow, archived_at: local.archivedAt }, { onConflict: 'id', ignoreDuplicates: true });
    if (bornErr) throw bornErr;
  }
  // v1.18.1 (NCC#180) — keep course pushes single-object upserts. An ARRAY
  // upsert writes the union of the rows' columns, and with supabase-js's
  // default `defaultToNull: true` a row missing one that another row carries
  // gets NULL there; for archived_at that is an un-archive.
  const { error } = await supabase.from('subjects').upsert(subjectRow);
  if (error) throw error;
  // v1.18.1 (NCC#180) — content AND archive changed in one edit: two writes.
  // set_updated_at() declines a whole row whose updated_at is older than the
  // server's, so riding the archive on the content upsert would let a newer
  // StudyDesk edit discard a newer NCC archive along with the stale content.
  // The archive write is decided on its own stamp.
  if (local.archiveEditedAt) {
    await pushCourseArchiveOnly(item, uuid, archivedAt, local.archiveEditedAt);
  }
}

/**
 * v1.18.1 (NCC#180) — an archive/restore made in NCC, written the way
 * StudyDesk#172 (setArchivedAt) writes one: only `archived_at` plus
 * `archived_edited_at` = the moment of the edit. The server keeps whichever
 * archive change is newer by that stamp and moves `updated_at` by 1 ms, so the
 * row's content keeps last-writer-wins; `updated_at` is therefore not sent.
 *
 * Until that migration is applied the column does not exist and the write is
 * refused (PGRST204 / 42703 naming it): retry the pre-1.18.1 way, archived_at
 * stamped with this edit's own `updated_at`.
 *
 * 0 rows matched: the server declined or dropped the change (an older archive
 * stamp, or no change at all), which is final — unless the row is not there
 * yet because this course's own insert is still queued (created in NCC, then
 * archived, and the insert failed transiently; pushQueue goes on past a failed
 * item). Then this item must stay queued and retry after the insert lands.
 * No insert fallback (StudyDesk has one): the queued insert is that fallback,
 * and writing the row from here could undo a declined change.
 */
async function pushCourseArchiveOnly(
  item: SyncQueueItem,
  uuid: string,
  archivedAt: string | null,
  editedAt: string,
): Promise<void> {
  let { data, error } = await supabase
    .from('subjects')
    .update({ archived_at: archivedAt, archived_edited_at: editedAt })
    .eq('id', uuid)
    .select('id');
  if (error) {
    if (!lacksArchiveStamp(error)) throw error;
    ({ data, error } = await supabase
      .from('subjects')
      .update({ archived_at: archivedAt, updated_at: stampOf(item) })
      .eq('id', uuid)
      .select('id'));
    if (error) throw error;
  }
  if (data && data.length > 0) return;
  if (await insertStillQueued(item.entityId)) {
    throw new Error('subjects: course not on the server yet (its insert is still queued); retrying the archive change');
  }
}

/** v1.18.1 (NCC#180) — an unsynced `course` insert for this id is in the queue. */
async function insertStillQueued(entityId: string): Promise<boolean> {
  const n = await db.syncQueue
    .filter((q) => q.entityType === 'course' && q.entityId === entityId && q.operation === 'insert' && !q.syncedAt)
    .count();
  return n > 0;
}

/** v1.18.1 (NCC#180) — PostgREST's answer to a column it does not know
 *  (PGRST204), or Postgres's (42703) behind it, naming archived_edited_at. */
function lacksArchiveStamp(error: { code?: string; message?: string }): boolean {
  return (error.code === 'PGRST204' || error.code === '42703')
    && /archived_edited_at/.test(error.message || '');
}

async function pushGrade(item: SyncQueueItem, ctx: PushContext): Promise<void> {
  if (item.operation === 'delete') {
    // NCC#57 — soft delete; StudyDesk only learns of deletes via tombstones.
    const stamp = new Date().toISOString();
    const { error } = await supabase
      .from('grades')
      .update({ deleted_at: stamp, updated_at: stamp })
      .eq('id', legacyIdToUuid(item.entityId));
    if (error) throw error;
    return;
  }
  const local: Grade = JSON.parse(item.payload);
  const updatedAt = stampOf(item, local);
  const row = {
    id: legacyIdToUuid(local.id),
    user_id: ctx.userId,
    subject_id: legacyIdToUuid(local.subjectId),
    grade: local.grade,
    weight: local.weight,
    date: local.date ?? null,
    updated_at: updatedAt,
  };
  const { error } = await supabase.from('grades').upsert(row);
  if (error) throw error;
}

// v1.2 — habits + habit_completions push handlers. Mirror the StudyDesk
// course/grade pair: habit is the parent, habit_completion the child with
// FK habit_id. ON DELETE CASCADE at the DB cleans the children when the
// parent goes; we still push the children's local tombstones via the queue
// for completeness so a partial outage doesn't leave them orphaned in our
// view (the DB cascade just makes it idempotent).
// v1.10 - in-app feedback.
//
// INSERT rather than UPSERT on purpose: `feedback` deliberately has no UPDATE
// policy, because a submitted report should not be silently editable, and an
// UPSERT onto an existing row becomes an UPDATE that RLS would then refuse. A
// 23505 means the first attempt actually landed, so it is success from the
// queue's point of view - swallowing it is what makes the retry idempotent.
// v1.12 Item 0 - retention.
//
// Retention was previously inferred from content-row timestamps and
// `auth.users.last_sign_in_at`. The latter moves on a silent token refresh, so
// it recorded that the client woke up rather than that the person came back.
//
// UPSERT on the composite primary key (user_id, app, opened_on): a queue retry,
// or a second foreground on the same day, resolves to the same row rather than
// a duplicate or a 23505.
async function pushAppOpen(item: SyncQueueItem, ctx: PushContext): Promise<void> {
  if (item.operation === 'delete') return; // opens are never deleted client-side
  const local = JSON.parse(item.payload) as {
    appVersion: string;
    platform: string;
    openedOn: string;
  };
  const { error } = await supabase.from('app_opens').upsert({
    user_id: ctx.userId,
    app: 'ncc',
    app_version: local.appVersion || null,
    platform: local.platform || null,
    opened_on: local.openedOn,
  }, { onConflict: 'user_id,app,opened_on' });
  if (error) throw error;
}

// v1.12 Item 10 - Braindump.
//
// Delete is a HARD delete, unlike the soft-delete tables: an entry the user
// threw away is a discarded thought, and nothing downstream needs a tombstone
// to reconcile against. (pushTask was the hard-delete precedent here until
// v1.16 moved tasks to tombstones, NCC#56. braindump_entries is not in
// `purge_soft_deleted()`, so its tombstones would never be cleaned up.)
async function pushBraindumpEntry(item: SyncQueueItem, ctx: PushContext): Promise<void> {
  if (item.operation === 'delete') {
    const { error } = await supabase
      .from('braindump_entries')
      .delete()
      .eq('id', item.entityId);
    if (error) throw error;
    return;
  }
  const local: BraindumpEntry = JSON.parse(item.payload);
  const { error } = await supabase.from('braindump_entries').upsert({
    id: local.id,
    user_id: ctx.userId,
    content: local.content,
    converted_task_id: local.convertedTaskId ?? null,
    created_at: local.createdAt,
    updated_at: stampOf(item, local),
  });
  if (error) throw error;
}

async function pushFeedback(item: SyncQueueItem, ctx: PushContext): Promise<void> {
  if (item.operation === 'delete') return; // feedback is append-only
  const local = JSON.parse(item.payload) as {
    id: string;
    category: string;
    rating: number | null;
    message: string;
    appVersion: string;
    platform: string;
  };
  const { error } = await supabase.from('feedback').insert({
    id: local.id,
    user_id: ctx.userId,
    app: 'ncc',
    app_version: local.appVersion || null,
    platform: local.platform || null,
    category: local.category,
    rating: local.rating,
    message: local.message,
  });
  if (error && (error as { code?: string }).code !== '23505') throw error;
}

async function pushHabit(item: SyncQueueItem, ctx: PushContext): Promise<void> {
  if (item.operation === 'delete') {
    const uuid = legacyIdToUuid(item.entityId);
    // Cascade-delete completions first (the DB cascade does this too, but
    // doing it here keeps the queue tidy if the parent delete races).
    await supabase.from('habit_completions').delete().eq('habit_id', uuid);
    const { error } = await supabase.from('habits').delete().eq('id', uuid);
    if (error) throw error;
    return;
  }
  const local: Habit = JSON.parse(item.payload);
  const updatedAt = stampOf(item, local);
  const row = {
    id: legacyIdToUuid(local.id),
    user_id: ctx.userId,
    title: local.title,
    type: local.type,
    target_amount: local.targetAmount ?? null,
    unit: local.unit ?? null,
    frequency_kind: local.frequencyKind,
    days_of_week: local.daysOfWeek ?? null,
    reminder_time: local.reminderTime ?? null,
    color: local.color ?? null,
    archived_at: local.archivedAt ?? null,
    updated_at: updatedAt,
  };
  const { error } = await supabase.from('habits').upsert(row);
  if (error) throw error;
}

// v1.16 (NCC#58). The server's identity for a completion is (habit_id, date) —
// `UNIQUE (habit_id, date)` — not the client-minted `id`. Two devices marking
// the same habit on the same day mint two ids for ONE fact. The second push
// then hit 23505, which `PERMANENT_PG_CODES` treats as permanent, so the item
// was silently DROPPED: that device's amount never reached the server, and its
// local row stayed alongside the pulled one, double-counting the day.
//
// The issue suggested upserting on the natural key with `id` omitted. That
// cannot work here: `habit_completions.id` has no default, so every new
// completion would fail NOT NULL (23502, also "permanent", also dropped).
// And keeping `id` in an ON CONFLICT (habit_id, date) upsert rewrites the
// server row's primary key to this device's id — the cross-device ping-pong
// StudyDesk's attendance went through. So: upsert by id as before, and only
// on the natural-key collision update the existing row's amount by
// (habit_id, date), leaving its id alone. The pull then adopts that id.
async function pushHabitCompletion(item: SyncQueueItem, ctx: PushContext): Promise<void> {
  if (item.operation === 'delete') {
    // New queue items carry the natural key, so an un-mark removes the day's
    // completion whatever id the server knows it by. Items queued by an older
    // build carry only `{ id }` and still delete by id.
    const target = JSON.parse(item.payload) as { habitId?: string; date?: string };
    let del = supabase.from('habit_completions').delete();
    del = target.habitId && target.date
      ? del.eq('habit_id', legacyIdToUuid(target.habitId)).eq('date', target.date)
      : del.eq('id', legacyIdToUuid(item.entityId));
    const { error } = await del;
    if (error) throw error;
    return;
  }
  const local: HabitCompletion = JSON.parse(item.payload);
  const row = {
    id: legacyIdToUuid(local.id),
    habit_id: legacyIdToUuid(local.habitId),
    user_id: ctx.userId,
    date: local.date,
    amount: local.amount,
  };
  const { error } = await supabase.from('habit_completions').upsert(row);
  if (error?.code === '23505') {
    const { error: sameDayErr } = await supabase
      .from('habit_completions')
      .update({ amount: row.amount })
      .eq('habit_id', row.habit_id)
      .eq('date', row.date);
    if (sameDayErr) throw sameDayErr;
    return;
  }
  if (error) throw error;
}

// v1.5 — Work domain self-assessment. NCC-native (no upstream app owns it).
// One row per (user, day); the local store keeps a stable id per date so this
// plain PK upsert collapses re-rates of the same day onto one row. The DB also
// has UNIQUE (user_id, log_date) as a backstop. updated_at drives LWW.
async function pushWorkQualityLog(item: SyncQueueItem, ctx: PushContext): Promise<void> {
  if (item.operation === 'delete') {
    const { error } = await supabase
      .from('work_quality_logs')
      .delete()
      .eq('id', legacyIdToUuid(item.entityId));
    if (error) throw error;
    return;
  }
  const local: WorkQualityLog = JSON.parse(item.payload);
  const updatedAt = stampOf(item, local);
  const row = {
    id: legacyIdToUuid(local.id),
    user_id: ctx.userId,
    log_date: local.date,
    rating: local.rating,
    note: local.note ?? null,
    updated_at: updatedAt,
  };
  const { error } = await supabase.from('work_quality_logs').upsert(row);
  // v1.18.1 (NCC#154): another device already holds this day under its own
  // id (the local store makes a random id per device), and UNIQUE (user_id,
  // log_date) refuses ours. It is the same fact, so write it onto that row,
  // as pushHabitCompletion does; the server's updated_at trigger keeps the
  // newer of the two.
  if (error?.code === '23505') {
    const { data: hit, error: sameDayErr } = await supabase
      .from('work_quality_logs')
      .update({ rating: row.rating, note: row.note, updated_at: row.updated_at })
      .eq('user_id', ctx.userId)
      .eq('log_date', row.log_date)
      .select('id');
    if (sameDayErr) throw sameDayErr;
    // The day's row went away between the two calls (deleted elsewhere).
    // Not a success: stay queued, and the next drain's upsert inserts it.
    if (!hit || hit.length === 0) throw new Error('work_quality_logs: no row for that day to update; retrying');
    return;
  }
  if (error) throw error;
}

// v1.19 (NCC#202) — a recurring rule. Deletes are tombstones (the rule's
// generated rows stay, or are deleted one by one, by the store).
// `waitingSince` is local-only.
async function pushRecurringRule(item: SyncQueueItem, ctx: PushContext): Promise<void> {
  if (item.operation === 'delete') {
    await softDelete('recurring_rules', item.entityId);
    return;
  }
  const local: RecurringRule = JSON.parse(item.payload);
  const row = {
    id: legacyIdToUuid(local.id),
    user_id: ctx.userId,
    kind: local.kind,
    template: local.template,
    every: local.every,
    unit: local.unit,
    anchor_day: local.anchorDay ?? null,
    start_date: local.startDate,
    end_date: local.endDate ?? null,
    last_materialized_date: local.lastMaterializedDate ?? null,
    paused_at: local.pausedAt ?? null,
    created_at: local.createdAt,
    updated_at: stampOf(item, local),
  };
  const { error } = await supabase.from('recurring_rules').upsert(row);
  if (error) throw error;
}

export const pushHandlers: Record<SyncQueueItem['entityType'], (item: SyncQueueItem, ctx: PushContext) => Promise<void>> = {
  transaction: pushTransaction,
  budget_category: pushBudgetCategory,
  portfolio_holding: pushPortfolioHolding,
  portfolio_lot: pushPortfolioLot,
  stock_sale: pushStockSale,
  portfolio_cash_entry: pushPortfolioCashEntry,
  manual_asset: pushManualAsset,
  watchlist_item: pushWatchlistItem,
  goal: pushGoal,
  // LimeLog owns workout_sessions / workout_sets. The binding data contract
  // makes NCC a read-only consumer of those tables, and the UI that fed this
  // path was removed in v1.5.2 — but the enqueue calls in useFitnessStore
  // survived, leaving a live write path one caller away from the production
  // tables. Those calls are gone now; these entries stay as drops rather than
  // being deleted so any mutation already sitting in an upgrading user's
  // outbox drains harmlessly instead of retrying forever.
  workout_session: async () => {
    /* discarded — see note above */
  },
  workout_set: async () => {
    /* discarded — see note above */
  },
  task: pushTask,
  course: pushCourse,
  grade: pushGrade,
  // StudyDesk owns study_sessions; the contract makes NCC a read-only
  // consumer, same as the workout tables above. No UI reached this either.
  study_session: async () => {
    /* discarded — see note above */
  },
  habit: pushHabit,
  feedback: pushFeedback,
  app_open: pushAppOpen,
  braindump_entry: pushBraindumpEntry,
  habit_completion: pushHabitCompletion,
  work_quality_log: pushWorkQualityLog,
  recurring_rule: pushRecurringRule,
  // grade_import is a local-only snapshot concept — courses sync individually.
  grade_import: async () => {
    /* no-op */
  },
};
