// Cloud -> Dexie hydration for the tables pullAll() does not cover inline
// (StudyDesk-owned studies tables, habits, body metrics, work quality,
// braindump, stock sales, portfolio cash). Moved out of cloudSync.ts
// unchanged (limecore#12).
import { supabase } from './supabase';
import { selectAll } from './selectAll';
import type { Table } from 'dexie';
import { recordSeen } from './editStamp';
import { db } from '../db/database';
import { listPending } from '../db/syncQueue';
import { legacyIdToUuid } from '../utils/uuid';
import type { StockSale, PortfolioCashEntry } from '../types/finance';
import type { Course, Grade, StudySession } from '../types/studies';
import type { BodyMetric } from '../types/fitness';
import { scaleFields } from './bodyScale';
import type { Habit, HabitCompletion } from '../types/habits';
import type { WorkQualityLog } from '../types/work';
import type { BraindumpEntry } from '../types/braindump';

/**
 * v1.18.1 (NCC#146, NCC#161) — write rows pulled from the cloud, skipping rows
 * with a change still waiting in the sync queue, and keeping `localOnly`
 * fields from the row already on this device.
 *  - Pending rows: the server's copy is older than this device's unsent
 *    edit. Writing it reverted the edit, and a second edit built on the
 *    reverted row then lost the first. They refresh on the pull after their
 *    push lands. The queue is read inside the same transaction as the write,
 *    so an edit queued while the pull's network reads ran is seen too. Both
 *    id forms count: a legacy local id reaches the server as
 *    legacyIdToUuid(id).
 *  - localOnly fields have no server column (the push never sends them), so
 *    the pulled copy always lacks them, and a plain bulkPut erased them on
 *    every sync.
 */
export async function putFromCloud<T extends { id: string }>(
  table: Table<T, string>,
  rows: T[],
  localOnly: (keyof T)[] = [],
): Promise<void> {
  await db.transaction('rw', table, db.syncQueue, async () => {
    const pendingIds = new Set<string>();
    for (const q of await listPending()) {
      pendingIds.add(q.entityId);
      pendingIds.add(legacyIdToUuid(q.entityId));
    }
    const fresh = rows.filter((r) => !pendingIds.has(r.id));
    if (localOnly.length > 0 && fresh.length > 0) {
      const existing = await table.bulkGet(fresh.map((r) => r.id));
      fresh.forEach((r, i) => {
        const prev = existing[i];
        if (!prev) return;
        for (const k of localOnly) {
          if (prev[k] !== undefined) r[k] = prev[k];
        }
      });
    }
    await table.bulkPut(fresh);
  });
}


// ============================================================================
// Studies hydration — explicit fetch-then-write for the three StudyDesk tables
// ============================================================================
// Background: NCC and StudyDesk share a Supabase project. StudyDesk owns the
// `subjects`, `grades`, and `study_sessions` schemas. When NCC opens and the
// user is signed in, we need to hydrate Dexie from the cloud BEFORE the
// Realtime subscription opens — otherwise rows that exist pre-subscribe are
// invisible to NCC (Realtime only delivers deltas from the moment you
// subscribe, not snapshots).
//
// Defense-in-depth choices:
//   - Explicit `user_id` filter on every SELECT instead of relying purely on
//     RLS. StudyDesk's RLS should scope these anyway, but if the policy is
//     ever wrong or missing the explicit filter limits blast radius.
//   - Each of the three tables is fetched in its own try/catch so one
//     table's failure doesn't lose the others.
//   - The `deleted_at IS NULL` filter is attempted first; on column-missing
//     (StudyDesk schema doesn't carry that column), we retry without it and
//     post-filter client-side. That way a column mismatch never silently
//     produces an empty hydration.
//   - Diagnostic console logs survive into release builds so `adb logcat`
//     can confirm row counts on device.

interface StudiesHydrationResult {
  subjects: number;
  grades: number;
  studySessions: number;
  errors: string[];
}

/**
 * v1.16 (NCC#56) — every row of a StudyDesk-owned table, tombstones included,
 * split into the live rows and the ids the server has marked deleted.
 *
 * This used to query with `deleted_at IS NULL` and `bulkPut` the result, so
 * NCC never learned of a delete: a course, grade or study session removed in
 * StudyDesk (which only ever soft-deletes) stayed on every NCC device that had
 * pulled it, and kept counting towards NCC's GPA, study hours and Life Score.
 * The server held 21 soft-deleted courses and 8 soft-deleted grades across
 * the accounts that use NCC when this was found.
 *
 * Pulling the tombstones is what lets the caller remove them. With no filter
 * on `deleted_at` there is no schema mismatch left to fall back from either,
 * so the old missing-column retry is gone with it.
 */
async function fetchStudyDeskTable(
  table: 'subjects' | 'grades' | 'study_sessions',
  userId: string,
): Promise<{ live: any[]; deletedIds: string[]; error: string | null }> {
  const { data, error } = await selectAll(supabase, table, {
    filter: (q) => q.eq('user_id', userId),
  });
  if (error) return { live: [], deletedIds: [], error: error.message };
  recordSeen(table, (data ?? []) as any[]);
  const live: any[] = [];
  const deletedIds: string[] = [];
  for (const r of (data ?? []) as any[]) {
    if (r.deleted_at) deletedIds.push(r.id);
    else live.push(r);
  }
  return { live, deletedIds, error: null };
}

/**
 * Remove the local rows the server has tombstoned. Returns how many went.
 *
 * Matched on the server id AND on `legacyIdToUuid(localId)`, because a row
 * created by an early NCC build can still sit locally under its legacy id
 * while the server knows it by the uuid it was pushed as.
 *
 * A pending local edit does not save a tombstoned row, and that is
 * deliberate: it is the rule StudyDesk's merge already applies ("a delete
 * beats a simultaneous edit"), and the server enforces it too — NCC's subject
 * and grade upserts never send `deleted_at`, so pushing that edit updates the
 * tombstoned row's content without un-deleting it. Keeping the row here would
 * only leave this device disagreeing with every other one.
 *
 * Known gap: `purge_soft_deleted()` hard-deletes tombstones older than 90
 * days, so a device that has not pulled for longer than that never sees the
 * tombstone and keeps the row.
 */
export async function removeTombstoned(
  table: Table<{ id: string }, string>,
  deletedIds: string[],
): Promise<number> {
  if (deletedIds.length === 0) return 0;
  const dead = new Set(deletedIds);
  const doomed = (await table.toArray())
    .filter((r) => dead.has(r.id) || dead.has(legacyIdToUuid(r.id)))
    .map((r) => r.id);
  if (doomed.length > 0) await table.bulkDelete(doomed);
  return doomed.length;
}

export async function hydrateStudiesTables(userId: string): Promise<StudiesHydrationResult> {
  const errors: string[] = [];
  let subjectCount = 0;
  let gradeCount = 0;
  let sessionCount = 0;

  // --- subjects ---
  try {
    const { live, deletedIds, error } = await fetchStudyDeskTable('subjects', userId);
    if (error) {
      errors.push(`subjects: ${error}`);
      console.warn('[studies-hydrate] subjects failed:', error);
    } else {
      const courses: Course[] = live.map((s: any) => ({
        id: s.id,
        importId: 'cloud',
        name: s.name,
        credits: Number(s.credits ?? 1),
        color: s.color ?? undefined,
        semester: s.semester ?? undefined,
        // v1.2 — archived_at column. Null/undefined = active. The studies
        // store filters this out of the active list + GPA but keeps the
        // row hydrated so a "Show archived" toggle can surface it.
        archivedAt: s.archived_at ?? undefined,
        createdAt: s.created_at,
      }));
      await putFromCloud(db.courses, courses);
      const removed = await removeTombstoned(db.courses, deletedIds);
      subjectCount = courses.length;
      console.log(`[studies-hydrate] subjects=${subjectCount} removed=${removed}`);
    }
  } catch (e) {
    errors.push(`subjects: ${(e as Error).message}`);
    console.warn('[studies-hydrate] subjects threw:', e);
  }

  // --- grades ---
  try {
    const { live, deletedIds, error } = await fetchStudyDeskTable('grades', userId);
    if (error) {
      errors.push(`grades: ${error}`);
      console.warn('[studies-hydrate] grades failed:', error);
    } else {
      const grades: Grade[] = live.map((g: any) => ({
        id: g.id,
        subjectId: g.subject_id,
        grade: Number(g.grade),
        weight: Number(g.weight ?? 1),
        date: g.date ?? undefined,
        syncStatus: 'synced' as const,
        createdAt: g.created_at,
        updatedAt: g.updated_at,
      }));
      await putFromCloud(db.grades, grades);
      const removed = await removeTombstoned(db.grades, deletedIds);
      gradeCount = grades.length;
      console.log(`[studies-hydrate] grades=${gradeCount} removed=${removed}`);
    }
  } catch (e) {
    errors.push(`grades: ${(e as Error).message}`);
    console.warn('[studies-hydrate] grades threw:', e);
  }

  // --- study_sessions ---
  try {
    const { live, deletedIds, error } = await fetchStudyDeskTable('study_sessions', userId);
    if (error) {
      errors.push(`study_sessions: ${error}`);
      console.warn('[studies-hydrate] study_sessions failed:', error);
    } else {
      const sessions: StudySession[] = live.map((r: any) => ({
        id: r.id,
        startedAt: r.started_at,
        durationMinutes: Number(r.duration_minutes),
        subjectId: r.subject_id ?? undefined,
        notes: r.notes ?? undefined,
        syncStatus: 'synced' as const,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      }));
      await putFromCloud(db.studySessions, sessions);
      const removed = await removeTombstoned(db.studySessions, deletedIds);
      sessionCount = sessions.length;
      console.log(`[studies-hydrate] study_sessions=${sessionCount} removed=${removed}`);
    }
  } catch (e) {
    errors.push(`study_sessions: ${(e as Error).message}`);
    console.warn('[studies-hydrate] study_sessions threw:', e);
  }

  return {
    subjects: subjectCount,
    grades: gradeCount,
    studySessions: sessionCount,
    errors,
  };
}

/**
 * Public entry point used by App.tsx on sign-in. Hydrates Dexie with every
 * StudyDesk row owned by `userId`, then returns the counts. Caller is
 * expected to refresh the studies store after this resolves and only THEN
 * open the Realtime subscription so subsequent deltas merge cleanly.
 */
export async function hydrateStudiesFromCloud(
  userId: string,
): Promise<StudiesHydrationResult> {
  return hydrateStudiesTables(userId);
}

// v1.2 — habits hydration. Same pattern as studies: pull everything for the
// user into Dexie before opening realtime so the local working set is
// authoritative from the first paint. The user's habit count is small (we
// can comfortably grab all completions) — for power users with multi-year
// history we may need a date-window filter later.
interface HabitsHydrationResult {
  habits: number;
  completions: number;
  errors: string[];
}

export async function hydrateHabitsFromCloud(
  userId: string,
): Promise<HabitsHydrationResult> {
  const errors: string[] = [];
  let habitCount = 0;
  let completionCount = 0;

  try {
    const { data, error } = await selectAll(supabase, 'habits', {
      filter: (q) => q.eq('user_id', userId),
    });
    if (error) throw error;
    if (data) {
      const habits: Habit[] = data.map((h: any) => ({
        id: h.id,
        title: h.title,
        type: h.type,
        targetAmount: h.target_amount != null ? Number(h.target_amount) : undefined,
        unit: h.unit ?? undefined,
        frequencyKind: h.frequency_kind,
        daysOfWeek: h.days_of_week ?? undefined,
        reminderTime: h.reminder_time ?? undefined,
        color: h.color ?? undefined,
        archivedAt: h.archived_at ?? undefined,
        syncStatus: 'synced' as const,
        createdAt: h.created_at,
        updatedAt: h.updated_at,
      }));
      await putFromCloud(db.habits, habits);
      habitCount = habits.length;
    }
  } catch (e) {
    const msg = (e as Error).message;
    errors.push(`habits: ${msg}`);
    console.warn('[habits-hydrate] habits failed:', msg);
  }

  try {
    const { data, error } = await selectAll(supabase, 'habit_completions', {
      filter: (q) => q.eq('user_id', userId),
    });
    if (error) throw error;
    if (data) {
      const completions: HabitCompletion[] = data.map((c: any) => ({
        id: c.id,
        habitId: c.habit_id,
        date: c.date,
        amount: Number(c.amount),
        syncStatus: 'synced' as const,
        createdAt: c.created_at,
      }));
      await putFromCloud(db.habitCompletions, completions);
      // v1.16 (NCC#58): one local row per (habit, day), and it is the
      // server's. A row minted on this device for a day another device had
      // already recorded — or the same row still held under its legacy id —
      // would otherwise sit beside the pulled one and count the day twice.
      // A pending edit on the removed row still reaches the server: its push
      // lands on the natural-key path in `pushHabitCompletion`.
      const serverIdByDay = new Map(completions.map((c) => [`${c.habitId}|${c.date}`, c.id]));
      const shadowed = (await db.habitCompletions.toArray())
        .filter((l) => {
          const serverId = serverIdByDay.get(`${legacyIdToUuid(l.habitId)}|${l.date}`);
          return serverId !== undefined && l.id !== serverId;
        })
        .map((l) => l.id);
      if (shadowed.length > 0) await db.habitCompletions.bulkDelete(shadowed);
      completionCount = completions.length;
    }
  } catch (e) {
    const msg = (e as Error).message;
    errors.push(`habit_completions: ${msg}`);
    console.warn('[habits-hydrate] completions failed:', msg);
  }

  return { habits: habitCount, completions: completionCount, errors };
}

// v1.3 — body metrics hydration. LimeLog owns the `body_metrics` table; NCC
// reads it (push-only flow, same as workout_sessions). Same pattern as
// habits: pull all rows for the user into Dexie so the Fitness screen's body
// section has data from the first paint, then the realtime channel (already
// subscribed to body_metrics since v1.2.1) handles deltas. Closes the
// AUDIT-FSG-5b residual — pullAll previously had nowhere to land these rows.
interface BodyMetricsHydrationResult {
  bodyMetrics: number;
  errors: string[];
}

export async function hydrateBodyMetricsFromCloud(
  userId: string,
): Promise<BodyMetricsHydrationResult> {
  const errors: string[] = [];
  let count = 0;

  try {
    const { data, error } = await selectAll(supabase, 'body_metrics', {
      filter: (q) => q.eq('user_id', userId),
    });
    if (error) throw error;
    if (data) {
      const rows: BodyMetric[] = (data as any[]).map((r) => ({
        id: r.id,
        date: r.date,
        weightKg: r.weight_kg != null ? Number(r.weight_kg) : undefined,
        chestCm: r.chest_cm != null ? Number(r.chest_cm) : undefined,
        waistCm: r.waist_cm != null ? Number(r.waist_cm) : undefined,
        hipsCm: r.hips_cm != null ? Number(r.hips_cm) : undefined,
        armsCm: r.arms_cm != null ? Number(r.arms_cm) : undefined,
        legsCm: r.legs_cm != null ? Number(r.legs_cm) : undefined,
        ...scaleFields(r),
        notes: r.notes ?? undefined,
        syncStatus: 'synced' as const,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      }));
      await putFromCloud(db.bodyMetrics, rows);
      count = rows.length;
    }
  } catch (e) {
    const msg = (e as Error).message;
    errors.push(`body_metrics: ${msg}`);
    console.warn('[body-metrics-hydrate] failed:', msg);
  }

  return { bodyMetrics: count, errors };
}

// v1.5 — Work domain self-assessment hydration. NCC-native table; same
// authenticated-client + RLS posture as the others. Bad/garbage rows degrade
// gracefully (a missing rating is coerced to a safe number; the whole batch
// isn't dropped on one bad row since map throwing would, so we guard fields).
interface WorkQualityHydrationResult {
  workQualityLogs: number;
  errors: string[];
}

export async function hydrateWorkQualityFromCloud(
  userId: string,
): Promise<WorkQualityHydrationResult> {
  const errors: string[] = [];
  let count = 0;

  try {
    const { data, error } = await selectAll(supabase, 'work_quality_logs', {
      filter: (q) => q.eq('user_id', userId),
    });
    if (error) throw error;
    recordSeen('work_quality_logs', (data ?? []) as any[]);
    if (data) {
      const rows: WorkQualityLog[] = (data as any[]).map((r) => ({
        id: r.id,
        date: r.log_date,
        rating: Number(r.rating) || 0,
        note: r.note ?? null,
        syncStatus: 'synced' as const,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      }));
      await putFromCloud(db.workQualityLogs, rows);
      count = rows.length;
      // v1.18.1 (NCC#154): a day this device rated under its own id while
      // another device's row for that day was already on the server. The
      // server row just landed, so the local one is a shadow: two rows for
      // one day, and edits went to whichever find() hit first. Drop it unless
      // a change to it is still queued (that push lands on the server row).
      const serverIdByDate = new Map(rows.map((r) => [r.date, r.id]));
      const queued = new Set((await listPending()).map((q) => q.entityId));
      const shadowed = (await db.workQualityLogs.toArray())
        .filter((l) => serverIdByDate.has(l.date) && serverIdByDate.get(l.date) !== l.id && !queued.has(l.id))
        .map((l) => l.id);
      if (shadowed.length > 0) await db.workQualityLogs.bulkDelete(shadowed);
    }
  } catch (e) {
    const msg = (e as Error).message;
    errors.push(`work_quality_logs: ${msg}`);
    console.warn('[work-quality-hydrate] failed:', msg);
  }

  return { workQualityLogs: count, errors };
}

interface BraindumpHydrationResult {
  braindumpEntries: number;
  errors: string[];
}

/**
 * v1.12 Item 10 - pull the user's braindump entries into Dexie.
 *
 * Same posture as the other hydrators: the ordinary authenticated client with
 * RLS as the gate, an explicit user_id filter as defence in depth, and a
 * try/catch so one bad row cannot take the whole sync down. Soft-deleted rows
 * are filtered out rather than tombstoned locally - nothing references an
 * entry, so there is no reconciliation that needs to see the deletion.
 */
export async function hydrateBraindumpFromCloud(
  userId: string,
): Promise<BraindumpHydrationResult> {
  const errors: string[] = [];
  let count = 0;
  try {
    const { data, error } = await selectAll(supabase, 'braindump_entries', {
      filter: (q) => q.eq('user_id', userId).is('deleted_at', null),
    });
    if (error) throw error;
    recordSeen('braindump_entries', (data ?? []) as any[]);
    if (data) {
      const rows: BraindumpEntry[] = (data as any[]).map((r) => ({
        id: r.id,
        // Coerced rather than trusted: content is free text arriving from the
        // network, and a null would break every consumer that measures length.
        content: typeof r.content === 'string' ? r.content : '',
        convertedTaskId: r.converted_task_id ?? null,
        syncStatus: 'synced' as const,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        deletedAt: null,
      }));
      await putFromCloud(db.braindumpEntries, rows);
      count = rows.length;
    }
  } catch (e) {
    const msg = (e as Error).message;
    errors.push(`braindump_entries: ${msg}`);
    console.warn('[braindump-hydrate] failed:', msg);
  }
  return { braindumpEntries: count, errors };
}

interface StockSalesHydrationResult {
  stockSales: number;
  errors: string[];
}

// v1.3.1 (BUG-23) — pull the user's realized stock sales into Dexie. Same
// authenticated-client + RLS posture as the other hydrators; bad/garbage rows
// degrade gracefully (lot_allocations falls back to []). No deleted_at filter
// — stock_sales is hard-delete (the table has no such column).
export async function hydrateStockSalesFromCloud(
  userId: string,
): Promise<StockSalesHydrationResult> {
  const errors: string[] = [];
  let count = 0;
  try {
    const { data, error } = await selectAll(supabase, 'stock_sales', {
      filter: (q) => q.eq('user_id', userId),
    });
    if (error) throw error;
    if (data) {
      const rows: StockSale[] = (data as any[]).map((r) => ({
        id: r.id,
        ticker: r.ticker,
        holdingId: r.holding_id ?? undefined,
        sharesSold: Number(r.shares_sold),
        salePricePerShare: Number(r.sale_price_per_share),
        costBasisPerShare: Number(r.cost_basis_per_share),
        realizedGainLoss: Number(r.realized_gain_loss),
        currency: r.currency,
        soldAt: r.sold_at,
        lotAllocations: Array.isArray(r.lot_allocations) ? r.lot_allocations : [],
        syncStatus: 'synced' as const,
        createdAt: r.created_at,
      }));
      await putFromCloud(db.stockSales, rows);
      count = rows.length;
    }
  } catch (e) {
    const msg = (e as Error).message;
    errors.push(`stock_sales: ${msg}`);
    console.warn('[stock-sales-hydrate] failed:', msg);
  }
  return { stockSales: count, errors };
}

interface PortfolioCashHydrationResult {
  portfolioCashEntries: number;
  errors: string[];
}

// v1.3.2 — pull the user's portfolio cash ledger into Dexie. Same RLS posture
// as the other hydrators. Hard-delete table (no deleted_at filter).
export async function hydratePortfolioCashFromCloud(
  userId: string,
): Promise<PortfolioCashHydrationResult> {
  const errors: string[] = [];
  let count = 0;
  try {
    const { data, error } = await selectAll(supabase, 'portfolio_cash_entries', {
      filter: (q) => q.eq('user_id', userId),
    });
    if (error) throw error;
    if (data) {
      const rows: PortfolioCashEntry[] = (data as any[]).map((r) => ({
        id: r.id,
        type: r.type,
        amount: Number(r.amount),
        currency: r.currency,
        accountId: r.account_id ?? undefined,
        relatedId: r.related_id ?? undefined,
        note: r.note ?? undefined,
        createdAt: r.created_at,
        syncStatus: 'synced' as const,
      }));
      // v1.18.1 (NCC#176) — accountAmount/accountCurrency are local-only (no
      // server column); putFromCloud keeps them, and skips rows with a change
      // still queued (NCC#146).
      await putFromCloud(db.portfolioCashEntries, rows, ['accountAmount', 'accountCurrency']);
      count = rows.length;
    }
  } catch (e) {
    const msg = (e as Error).message;
    errors.push(`portfolio_cash_entries: ${msg}`);
    console.warn('[portfolio-cash-hydrate] failed:', msg);
  }
  return { portfolioCashEntries: count, errors };
}
