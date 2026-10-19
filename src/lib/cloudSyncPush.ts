// Push mappers: one function per syncQueue entity type, each turning a
// queued local edit into the Supabase write for it. Drained in order by
// pushQueue() in cloudSync.ts. Moved out of cloudSync.ts unchanged (limecore#12).
import { supabase } from './supabase';
import { stampOf } from './editStamp';
import { SyncQueueItem } from '../db/database';
import { legacyIdToUuid } from '../utils/uuid';
import type { Transaction, BudgetCategory, PortfolioHolding, PortfolioLot, ManualAsset, WatchlistItem, StockSale, PortfolioCashEntry } from '../types/finance';
import type { Course, Grade } from '../types/studies';
import type { Task, TaskPriority } from '../types/tasks';
import type { Goal } from '../types/goals';
import type { Habit, HabitCompletion } from '../types/habits';
import type { WorkQualityLog } from '../types/work';
import type { BraindumpEntry } from '../types/braindump';

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
  const { error } = await supabase.from('transactions').upsert(row);
  if (error) throw error;
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
    const { error } = await supabase
      .from('portfolio_holdings')
      .delete()
      .eq('id', legacyIdToUuid(item.entityId));
    if (error) throw error;
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
  const { error } = await supabase.from('portfolio_lots').upsert(row);
  if (error) throw error;
}

// v1.3.1 (BUG-23) — realized stock sale. Append-only on the cloud (hard delete
// on removal — there's no deleted_at column, matching the plan's schema). The
// per-lot soldShares is NOT pushed (the cloud portfolio_lots table has no such
// column); it's derived on every device from these sales' lot_allocations.
async function pushStockSale(item: SyncQueueItem, ctx: PushContext): Promise<void> {
  if (item.operation === 'delete') {
    const { error } = await supabase
      .from('stock_sales')
      .delete()
      .eq('id', legacyIdToUuid(item.entityId));
    if (error) throw error;
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

// v1.3.2 — portfolio cash ledger entry. Hard-delete (no deleted_at), same as
// stock_sales — the table is a personal append-only ledger.
async function pushPortfolioCashEntry(item: SyncQueueItem, ctx: PushContext): Promise<void> {
  if (item.operation === 'delete') {
    const { error } = await supabase
      .from('portfolio_cash_entries')
      .delete()
      .eq('id', legacyIdToUuid(item.entityId));
    if (error) throw error;
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
  const { error } = await supabase.from('portfolio_cash_entries').upsert(row);
  if (error) throw error;
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
    due_date: local.dueDate ?? null,
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
  const local: Course = JSON.parse(item.payload);
  const uuid = legacyIdToUuid(local.id);
  const subjectRow = {
    id: uuid,
    user_id: ctx.userId,
    name: local.name,
    credits: local.credits,
    semester: local.semester ?? null,
    color: local.color ?? null,
    // v1.2 — bidirectional archive sync. If NCC ever exposes an archive
    // toggle for subjects locally, this carries it upstream; for now NCC
    // is purely a consumer of StudyDesk's archive state but the push
    // shape stays symmetric so the LWW merge isn't lopsided.
    archived_at: local.archivedAt ?? null,
    updated_at: stampOf(item),
  };
  const { error } = await supabase.from('subjects').upsert(subjectRow);
  if (error) throw error;
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
  // grade_import is a local-only snapshot concept — courses sync individually.
  grade_import: async () => {
    /* no-op */
  },
};
