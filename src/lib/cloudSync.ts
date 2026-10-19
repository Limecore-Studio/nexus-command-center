// Two-way sync between local Dexie and Supabase Postgres.
//
// Push: drain the local syncQueue, mapping each entry to the right
// Supabase table and stamping user_id from the current session.
//
// Pull: fetch all rows owned by (or shared with) the current user and
// upsert them into Dexie. RLS guarantees we only see what we're allowed to.
//
// Mapping is non-trivial — the local Dexie schema uses camelCase + some
// shape differences (e.g. local Course = one row containing both subject and
// grade info; Supabase splits subjects + grades). The conversions live here,
// in cloudSyncPush.ts (local -> remote) and in cloudSyncHydrate.ts (remote ->
// local); v1.17 split them out of this file unchanged (limecore#12).
//
// Conflict policy: per-row LWW based on actual edit time.
//
// Every push payload includes `updated_at` derived from the syncQueue item's
// createdAt (i.e. when the user made the edit on this device, NOT when push
// happens). The server's `set_updated_at` trigger (see migration
// `stale_write_protection_lww`) compares incoming `updated_at` against the
// row on disk and silently drops writes that are older. Two devices editing
// offline are ordered by edit time when they sync.
//
// This is enough for our usage pattern (occasional cross-device edits, no
// real concurrent collaboration). Full CRDT is overkill.
import { supabase } from './supabase';
import { selectAll } from './selectAll';
import type { Table } from 'dexie';
import { recordSeen } from './editStamp';
import { db, SyncQueueItem } from '../db/database';
import { listPending } from '../db/syncQueue';
import { generateId } from '../utils/uuid';
import type { Transaction, BudgetCategory, PortfolioHolding, PortfolioLot, ManualAsset, WatchlistItem } from '../types/finance';
import { legacyAssetTypeToAccountType } from '../types/finance';
import type { WorkoutSession, WorkoutSet } from '../types/fitness';
import type { Task } from '../types/tasks';
import type { Goal, GoalType } from '../types/goals';
import { selectRequeue, REQUEUE_TAG } from './requeueDropped';
import { hydrateBodyMetricsFromCloud, hydrateBraindumpFromCloud, hydrateHabitsFromCloud, hydratePortfolioCashFromCloud, hydrateStockSalesFromCloud, hydrateStudiesTables, hydrateWorkQualityFromCloud, putFromCloud, removeTombstoned } from './cloudSyncHydrate';
import { pushHandlers } from './cloudSyncPush';
export { hydrateBodyMetricsFromCloud, hydrateBraindumpFromCloud, hydrateHabitsFromCloud, hydrateStudiesFromCloud, hydrateWorkQualityFromCloud } from './cloudSyncHydrate';

// ============================================================================
// Push: drain queue to Supabase
// ============================================================================
export interface PushResult {
  attempted: number;
  succeeded: number;
  failed: number;
  errors: { entityType: string; entityId: string; message: string }[];
}

// FK dependency order: lower numbers push first.
// budget_categories must exist before transactions reference them; workout_sessions
// before workout_sets; subjects before grades (subjects+grades both come from
// 'course' entity in our local model, handled together in pushCourse).
// study_session.subject_id is a nullable FK to subjects, so courses (which
// push subjects) need to land first.
const ENTITY_PRIORITY: Record<SyncQueueItem['entityType'], number> = {
  // Independent of everything else; last so real data syncs first.
  feedback: 9,
  budget_category: 1,
  portfolio_holding: 1,
  workout_session: 1,
  task: 1,
  course: 1,
  grade_import: 1,
  grade: 2, // FK → subjects (course)
  workout_set: 2, // FK → workout_sessions
  transaction: 2, // FK → budget_categories (nullable, but order anyway)
  study_session: 2, // FK → subjects (nullable)
  portfolio_lot: 2, // FK → portfolio_holdings
  stock_sale: 2, // logically follows holdings (holding_id is a plain ref, no hard FK)
  portfolio_cash_entry: 2, // related_id is a plain ref to a lot/sale, no hard FK
  manual_asset: 1, // no FK dependencies
  watchlist_item: 1, // no FK dependencies
  goal: 1, // no FK dependencies
  habit: 1, // parent — no FK dependencies
  habit_completion: 2, // FK → habits
  work_quality_log: 1, // NCC-native, no FK dependencies
  app_open: 1, // no FK dependencies beyond auth.users
  // 2, not 1: converted_task_id references tasks. The FK is ON DELETE SET NULL
  // so an out-of-order push degrades to a lost link rather than an error, but
  // ordering it correctly means the link simply survives.
  braindump_entry: 2,
};

// Postgres integrity-constraint violations whose cause is the payload itself, not
// a transient network/auth condition. Retrying these can never succeed, so the
// queue should drop them rather than retry forever. (23502 not-null, 23503 FK,
// 23514 check, 22P02 invalid-text, 22003 numeric-out-of-range, 23505 unique_violation
// — a duplicate insert will never stop conflicting, 42501 insufficient_privilege/RLS
// denial — the policy isn't going to change on the next retry.)
const PERMANENT_PG_CODES = new Set(['23502', '23503', '23514', '22P02', '22003', '23505', '42501']);
function isPermanentSyncError(e: unknown): boolean {
  const code = (e as { code?: string } | null)?.code;
  return typeof code === 'string' && PERMANENT_PG_CODES.has(code);
}

/**
 * v1.18.1 (NCC#147) — the request never reached the server or never came
 * back: no network, or an aborted or timed-out fetch. supabase-js reports
 * these as an error object with `code: ''`. Every PostgREST answer carries a
 * code (a SQLSTATE or PGRSTnnn). A body with no code at all (a gateway or WAF
 * page) is NOT counted: the server did answer, and such a page can be
 * specific to one payload, which would then stop every drain at that item.
 */
export function isTransportError(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  if (e instanceof Error) {
    return e.name === 'AbortError' || (e.name === 'TypeError' && /fetch|network|load failed/i.test(e.message));
  }
  return (e as { code?: unknown }).code === '';
}

async function hasLiveSession(): Promise<boolean> {
  try {
    const { data } = await supabase.auth.getSession();
    return !!data.session;
  } catch {
    return false;
  }
}

export async function pushQueue(userId: string): Promise<PushResult> {
  // NCC#55 — one-time rescue of accounts and transactions dropped by the old
  // manual_assets CHECK. See requeueDropped.ts.
  const requeue = selectRequeue(await db.syncQueue.toArray());
  for (const it of requeue) {
    await db.syncQueue.update(it.id, { syncedAt: undefined, lastError: undefined, requeuedFor: REQUEUE_TAG });
  }
  const pending = await listPending();
  pending.sort((a, b) => {
    const pa = ENTITY_PRIORITY[a.entityType] ?? 99;
    const pb = ENTITY_PRIORITY[b.entityType] ?? 99;
    if (pa !== pb) return pa - pb;
    return a.createdAt.localeCompare(b.createdAt);
  });

  const result: PushResult = { attempted: 0, succeeded: 0, failed: 0, errors: [] };
  const now = new Date().toISOString();
  // v1.18.1 (NCC#147): the lowest priority (a parent tier) that failed in this
  // drain without being dropped. A child's FK violation after that is the
  // parent not being there YET, not a payload that can never land. This is by
  // tier, not by the child's own parent: while any parent-tier item keeps
  // failing, a child whose parent is really gone stays pending too (and its
  // row is not refreshed by the pull) instead of being dropped. Holding a
  // row back is the safer side of that trade; losing it is not recoverable.
  let parentFailedAt = Infinity;

  for (const item of pending) {
    result.attempted++;
    const handler = pushHandlers[item.entityType];
    if (!handler) {
      result.failed++;
      continue;
    }
    try {
      await handler(item, { userId });
      await db.syncQueue.update(item.id, { syncedAt: now, lastError: undefined });
      result.succeeded++;
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      const code = (e as { code?: string } | null)?.code;
      const priority = ENTITY_PRIORITY[item.entityType] ?? 99;
      const parentPending = code === '23503' && parentFailedAt < priority;
      // v1.18.1 (NCC#162): with no session, supabase-js sends the publishable
      // key and RLS refuses as anon. That is the session ending mid-drain
      // (refresh refused, signed out elsewhere), not a payload RLS will
      // always refuse: leave this and everything after it queued.
      if (code === '42501' && !(await hasLiveSession())) {
        await db.syncQueue.update(item.id, { lastError: msg });
        result.errors.push({ entityType: item.entityType, entityId: item.entityId, message: msg });
        result.failed++;
        break;
      }
      if (isPermanentSyncError(e) && !parentPending) {
        // Non-retryable: the payload itself is invalid (e.g. a lot pointing at a
        // deleted holding → FK violation, or a malformed account → check/not-null
        // violation). Retrying every drain just spams the error banner forever, so
        // drop the item from the pending set (mark it synced) and surface it once.
        await db.syncQueue.update(item.id, { syncedAt: now, lastError: `[dropped] ${msg}` });
        result.errors.push({ entityType: item.entityType, entityId: item.entityId, message: `[dropped, won't retry] ${msg}` });
      } else {
        await db.syncQueue.update(item.id, { lastError: msg });
        result.errors.push({ entityType: item.entityType, entityId: item.entityId, message: msg });
        parentFailedAt = Math.min(parentFailedAt, priority);
      }
      result.failed++;
      // v1.18.1 (NCC#147): no network means every remaining item would fail
      // the same way (each after its own timeout). Stop; they stay pending
      // for the next drain, parents still ahead of their children.
      if (isTransportError(e)) break;
    }
  }
  return result;
}

// ============================================================================
// Pull: fetch user-owned + shared rows, upsert into Dexie
// ============================================================================
export interface PullResult {
  transactions: number;
  budgetCategories: number;
  portfolioHoldings: number;
  portfolioLots: number;
  manualAssets: number;
  watchlistItems: number;
  subjects: number;
  grades: number;
  workoutSessions: number;
  workoutSets: number;
  tasks: number;
  studySessions: number;
  goals: number;
  habits: number;
  habitCompletions: number;
  bodyMetrics: number;
  stockSales: number;
  portfolioCashEntries: number;
  workQualityLogs: number;
  braindumpEntries: number;
  errors: string[];
}

export async function pullAll(_userId: string): Promise<PullResult> {
  const errors: string[] = [];
  const result: PullResult = {
    transactions: 0,
    budgetCategories: 0,
    portfolioHoldings: 0,
    portfolioLots: 0,
    manualAssets: 0,
    watchlistItems: 0,
    subjects: 0,
    grades: 0,
    workoutSessions: 0,
    workoutSets: 0,
    tasks: 0,
    studySessions: 0,
    goals: 0,
    habits: 0,
    habitCompletions: 0,
    bodyMetrics: 0,
    stockSales: 0,
    portfolioCashEntries: 0,
    workQualityLogs: 0,
    braindumpEntries: 0,
    errors,
  };

  // v1.18.1 (NCC#146) — see putFromCloud in cloudSyncHydrate.ts.
  const putPulled = putFromCloud;

  // Helper: pull a Supabase table, filter deleted, map back to local shape, write to Dexie.
  //
  // v1.16 (NCC#56 part 2) — pass `tombstonesIn`, the local table the rows land
  // in, and the pull keeps the server's tombstones instead of filtering them
  // out: only live rows are mapped and written, and every local row the server
  // has marked deleted is removed (see removeTombstoned). Callers that pass it
  // must not also filter on `deleted_at`, or no tombstone ever arrives.
  async function pullTable<R, L>(
    table: string,
    extraFilters: { column: string; op: 'is' | 'eq'; value: unknown }[],
    mapRowToLocal: (r: R) => L | null,
    writeToDexie: (rows: L[]) => Promise<void>,
    tombstonesIn?: Table<any, string>
  ): Promise<number> {
    const { data, error } = await selectAll(supabase, table, {
      filter: (q) => {
        for (const f of extraFilters) {
          if (f.op === 'is') q = q.is(f.column, f.value as null);
          else q = q.eq(f.column, f.value as string | number);
        }
        return q;
      },
    });
    if (error) {
      errors.push(`${table}: ${error.message}`);
      return 0;
    }
    recordSeen(table, data as any[]);
    const rows = data as any[];
    const live = tombstonesIn ? rows.filter((r) => !r.deleted_at) : rows;
    const mapped = (live as R[]).map(mapRowToLocal).filter((x): x is L => x !== null);
    await writeToDexie(mapped);
    if (tombstonesIn) {
      await removeTombstoned(tombstonesIn, rows.filter((r) => r.deleted_at).map((r) => r.id));
    }
    return mapped.length;
  }

  result.transactions = await pullTable<any, Transaction>(
    'transactions',
    [],
    (r) => {
      // Transfers are stored cloud-side as `expense` + a `[transfer]` description
      // prefix (the cloud `type` CHECK predates the transfer type). Reconstruct the
      // local `transfer` type from a present destination account OR the legacy
      // prefix, and strip the marker so the description renders clean.
      const rawDesc: string = r.description ?? '';
      const isTransfer = r.destination_account_id != null || rawDesc.startsWith('[transfer] ');
      return {
        id: r.id,
        amount: Number(r.amount),
        description: rawDesc.replace(/^\[transfer\]\s/, ''),
        categoryId: r.category_id ?? undefined,
        accountId: r.account_id ?? undefined,
        destinationAccountId: r.destination_account_id ?? undefined,
        date: r.date,
        type: (isTransfer ? 'transfer' : r.type) as Transaction['type'],
        syncStatus: 'synced',
        createdAt: r.created_at,
      };
    },
    async (rows) => {
      await putPulled(db.transactions, rows, ['notes']);
    },
    db.transactions
  );

  result.budgetCategories = await pullTable<any, BudgetCategory>(
    'budget_categories',
    [],
    (r) => ({
      id: r.id,
      name: r.name,
      monthlyLimit: Number(r.monthly_limit ?? 0),
      icon: r.color ?? undefined,
      createdAt: r.created_at,
      ownerId: r.user_id,
    }),
    async (rows) => {
      await putPulled(db.budgetCategories, rows, ['linkedManualAssetId']);
    },
    db.budgetCategories
  );

  result.portfolioHoldings = await pullTable<any, PortfolioHolding>(
    'portfolio_holdings',
    [],
    (r) => ({
      id: r.id,
      ticker: r.ticker,
      name: r.name ?? r.ticker,
      assetType: r.asset_type as PortfolioHolding['assetType'],
      quantity: Number(r.quantity),
      avgCostNative: r.avg_cost_native != null ? Number(r.avg_cost_native) : undefined,
      costCurrency: r.cost_currency ?? undefined,
      sectorOverride: r.sector_override ?? undefined,
      createdAt: r.created_at,
    }),
    async (rows) => {
      await putPulled(db.portfolioHoldings, rows);
    }
  );

  // Studies: pull subjects → courses (no embedded grade) AND grades → grades
  // table separately. Each subject can have many grades, each with its own
  // weight + date — Nexus mirrors StudyDesk's full shape now.
  //
  // Important: subjects and grades are pulled INDEPENDENTLY so one failure
  // doesn't poison the other. StudyDesk owns these tables — if either lacks
  // a `deleted_at` column the filter falls back to "no filter" so we don't
  // silently drop everything on a schema mismatch.
  const studiesHydration = await hydrateStudiesTables(_userId);
  result.subjects = studiesHydration.subjects;
  result.grades = studiesHydration.grades;
  for (const e of studiesHydration.errors) errors.push(e);

  result.workoutSessions = await pullTable<any, WorkoutSession>(
    'workout_sessions',
    [{ column: 'deleted_at', op: 'is', value: null }],
    (r) => ({
      id: r.id,
      sessionType: r.session_type,
      date: r.date,
      sets: [],
      notes: r.notes ?? undefined,
      syncStatus: 'synced',
      createdAt: r.created_at,
    }),
    async (rows) => {
      await db.workoutSessions.bulkPut(rows);
      // v1.5.7 — reconcile: pullTable upserts but never prunes, so workout
      // sessions that LimeLog deleted upstream (or duplicate rows from an old
      // push bug) linger locally and inflate the weekly workout count + goal
      // progress. Drop any CLOUD-SOURCED ('synced') local session that is no
      // longer in the active cloud set, and cascade-delete its sets. Local
      // unsynced ('pending') sessions are preserved — they haven't pushed yet.
      //
      // v1.16 (limecore#28): this prune is only safe because `rows` is the
      // COMPLETE cloud set. It is a delete keyed on "absent from the pull", so
      // a pull truncated at the API row cap would delete real workouts from
      // this device. `pullTable` fetches through `selectAll`, which pages to
      // completion or returns an error, and on an error this writer is never
      // called. Keep it that way: never feed this prune a partial list.
      const cloudIds = new Set(rows.map((r) => r.id));
      const localSessions = await db.workoutSessions.toArray();
      const staleIds = localSessions
        .filter((s) => s.syncStatus !== 'pending' && !cloudIds.has(s.id))
        .map((s) => s.id);
      if (staleIds.length > 0) {
        await db.workoutSessions.bulkDelete(staleIds);
        await db.workoutSets.where('sessionId').anyOf(staleIds).delete();
      }
    }
  );

  result.workoutSets = await pullTable<any, WorkoutSet>(
    'workout_sets',
    [],
    (r) => ({
      id: r.id,
      sessionId: r.session_id,
      exercise: r.exercise,
      weightKg: r.weight_kg != null ? Number(r.weight_kg) : undefined,
      reps: r.reps ?? undefined,
      rpe: r.rpe != null ? Number(r.rpe) : undefined,
      createdAt: r.created_at,
    }),
    async (rows) => {
      await db.workoutSets.bulkPut(rows);
      // v1.5.7 — drop orphan sets whose parent session no longer exists locally
      // (e.g. after a session was pruned above, or a set was deleted upstream).
      // Sets carry no syncStatus, so we key off the parent: any set pointing at
      // a session id that isn't in workoutSessions is dead weight.
      const liveSessionIds = new Set((await db.workoutSessions.toArray()).map((s) => s.id));
      const orphanSetIds = (await db.workoutSets.toArray())
        .filter((st) => !liveSessionIds.has(st.sessionId))
        .map((st) => st.id);
      if (orphanSetIds.length > 0) {
        await db.workoutSets.bulkDelete(orphanSetIds);
      }
    }
  );

  result.tasks = await pullTable<any, Task>(
    'tasks',
    [],
    (r) => ({
      id: r.id,
      title: r.title,
      dueDate: r.due_date ?? undefined,
      priority: (r.priority === 'normal' ? 'medium' : r.priority) as Task['priority'],
      completed: r.status === 'done',
      notes: r.description ?? undefined,
      syncStatus: 'synced',
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      ownerId: r.user_id,
    }),
    async (rows) => {
      await putPulled(db.tasks, rows, ['category']);
    },
    db.tasks
  );

  // study_sessions: resilient fetch — drop the deleted_at filter on schema
  // mismatch rather than dropping every row. See hydrateStudiesTables for
  // the same pattern on subjects + grades.
  result.studySessions = studiesHydration.studySessions;

  result.manualAssets = await pullTable<any, ManualAsset>(
    'manual_assets',
    [],
    (r) => {
      // v1.2 follow-up — CTO Account refactor. Server rows still carry the
      // legacy `asset_type` / `value` field names; we mirror them onto the
      // canonical `accountType` / `startingBalance` fields at hydration so
      // the in-memory shape matches Account. legacyAssetTypeToAccountType
      // also fixes the 'credit' → 'credit_card' rename for any rows that
      // synced in pre-refactor.
      const accountType = legacyAssetTypeToAccountType(r.asset_type);
      const startingBalance = Number(r.value);
      return {
        id: r.id,
        name: r.name,
        accountType,
        startingBalance,
        assetType: accountType,
        value: startingBalance,
        currency: r.currency,
        notes: r.notes ?? undefined,
        syncStatus: 'synced',
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      } as ManualAsset;
    },
    async (rows) => {
      await putPulled(db.manualAssets, rows);
    },
    db.manualAssets
  );

  result.watchlistItems = await pullTable<any, WatchlistItem>(
    'watchlist_items',
    [],
    (r) => ({
      id: r.id,
      ticker: r.ticker,
      name: r.name,
      assetType: r.asset_type as WatchlistItem['assetType'],
      notes: r.notes ?? undefined,
      targetAbove: r.target_above != null ? Number(r.target_above) : undefined,
      targetBelow: r.target_below != null ? Number(r.target_below) : undefined,
      syncStatus: 'synced',
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }),
    async (rows) => {
      await putPulled(db.watchlistItems, rows);
    },
    db.watchlistItems
  );

  result.goals = await pullTable<any, Goal>(
    'goals',
    [],
    (r) => ({
      id: r.id,
      title: r.title,
      goalType: r.goal_type as GoalType,
      targetValue: Number(r.target_value),
      targetDate: r.target_date ?? undefined,
      startDate: r.start_date,
      exerciseName: r.exercise_name ?? undefined,
      currency: r.currency ?? undefined,
      completed: !!r.completed,
      completedAt: r.completed_at ?? undefined,
      syncStatus: 'synced',
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }),
    async (rows) => {
      await putPulled(db.goals, rows);
    },
    db.goals
  );

  result.portfolioLots = await pullTable<any, PortfolioLot>(
    'portfolio_lots',
    [],
    (r) => ({
      id: r.id,
      holdingId: r.holding_id,
      quantity: Number(r.quantity),
      costPerUnit: Number(r.cost_per_unit),
      costCurrency: r.cost_currency,
      purchaseDate: r.purchase_date ?? undefined,
      notes: r.notes ?? undefined,
      syncStatus: 'synced',
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }),
    async (rows) => {
      await putPulled(db.portfolioLots, rows);
    },
    db.portfolioLots
  );

  // v1.3 AUDIT-FSG-5b — extend pullAll coverage so cross-device habit edits
  // re-render after the realtime channel's schedulePull → useSyncStore.syncNow
  // → pullAll path actually pulls these tables. v1.2.1 AUDIT-FSG-5 added the
  // realtime subscription but pullAll never iterated habits/habit_completions,
  // so notifications fired but the local Dexie was only rehydrated on cold
  // start via the dedicated hydrateHabitsFromCloud cold-start hook. Now both
  // paths re-use the same hydration helper. (v1.3 — body_metrics joins them
  // below now that NCC has a Dexie table + Fitness UI surface for them.)
  const habitsHydration = await hydrateHabitsFromCloud(_userId);
  result.habits = habitsHydration.habits;
  result.habitCompletions = habitsHydration.completions;
  for (const e of habitsHydration.errors) errors.push(e);

  // v1.3 — body metrics now have a Dexie home (table added in db v14), so the
  // realtime-triggered pull actually lands them. Closes the v1.2.1
  // AUDIT-FSG-5b residual: the body_metrics realtime subscription fired
  // schedulePull → syncNow → pullAll, but pullAll had no body_metrics step
  // and no local table, so cross-device body-metric edits only surfaced on
  // cold start. Now both paths converge on hydrateBodyMetricsFromCloud.
  const bodyMetricsHydration = await hydrateBodyMetricsFromCloud(_userId);
  result.bodyMetrics = bodyMetricsHydration.bodyMetrics;
  for (const e of bodyMetricsHydration.errors) errors.push(e);

  // v1.3.1 (BUG-23) — realized stock sales. Hydrate-in-pullAll so a sale made
  // on another device surfaces on the next sync (cold start + 30s flusher +
  // realtime-triggered pull all route through here). soldShares is re-derived
  // from these in useFinanceStore.load() after the reload.
  const stockSalesHydration = await hydrateStockSalesFromCloud(_userId);
  result.stockSales = stockSalesHydration.stockSales;
  for (const e of stockSalesHydration.errors) errors.push(e);

  const cashHydration = await hydratePortfolioCashFromCloud(_userId);
  result.portfolioCashEntries = cashHydration.portfolioCashEntries;
  for (const e of cashHydration.errors) errors.push(e);

  // v1.5 — Work domain self-assessment. NCC-native; hydrate-in-pullAll so a
  // rating logged on another device surfaces on the next sync, mirroring the
  // habits/body-metrics convergence above.
  const workQualityHydration = await hydrateWorkQualityFromCloud(_userId);
  result.workQualityLogs = workQualityHydration.workQualityLogs;
  for (const e of workQualityHydration.errors) errors.push(e);

  // v1.12 Item 10 - Braindump.
  const braindumpHydration = await hydrateBraindumpFromCloud(_userId);
  result.braindumpEntries = braindumpHydration.braindumpEntries;
  for (const e of braindumpHydration.errors) errors.push(e);

  return result;
}

// ============================================================================
// Adoption: enqueue every existing local row as an insert for the new user.
// ============================================================================
export async function adoptLocalData(userId: string): Promise<number> {
  const now = new Date().toISOString();
  let count = 0;

  const enqueueAll = async (
    entityType: SyncQueueItem['entityType'],
    rows: { id: string }[]
  ) => {
    for (const row of rows) {
      await db.syncQueue.add({
        id: generateId(),
        entityType,
        entityId: row.id,
        operation: 'insert',
        payload: JSON.stringify(row),
        createdAt: now,
      });
      count++;
    }
  };

  // Only adopt rows that were created locally and never synced. On a shared
  // device, signing in as User A hydrates A's cloud rows into local Dexie as
  // syncStatus: 'synced' and leaves them local on sign-out; without this
  // filter, User B adopting would re-push A's rows under B's account using
  // A's original ids — cross-user data corruption. Tables with no
  // per-row syncStatus field (budgetCategories/portfolioHoldings/courses)
  // adopt in full, same as before.
  const [txs, budgets, holdings, lots, manualAssets, watchlistItems, tasks, courses, grades, goals, stockSales, cashEntries, workQualityLogs] =
    await Promise.all([
      db.transactions.filter((r) => r.syncStatus === 'pending').toArray(),
      db.budgetCategories.toArray(), // no syncStatus field
      db.portfolioHoldings.toArray(), // no syncStatus field
      db.portfolioLots.filter((r) => r.syncStatus === 'pending').toArray(),
      db.manualAssets.filter((r) => r.syncStatus === 'pending').toArray(),
      db.watchlistItems.filter((r) => r.syncStatus === 'pending').toArray(),
      db.tasks.filter((r) => r.syncStatus === 'pending').toArray(),
      db.courses.toArray(), // no syncStatus field
      db.grades.filter((r) => r.syncStatus === 'pending').toArray(),
      db.goals.filter((r) => r.syncStatus === 'pending').toArray(),
      db.stockSales.filter((r) => r.syncStatus === 'pending').toArray(),
      db.portfolioCashEntries.filter((r) => r.syncStatus === 'pending').toArray(),
      db.workQualityLogs.filter((r) => r.syncStatus === 'pending').toArray(),
    ]);

  await enqueueAll('transaction', txs);
  await enqueueAll('budget_category', budgets);
  await enqueueAll('portfolio_holding', holdings);
  await enqueueAll('portfolio_lot', lots);
  await enqueueAll('manual_asset', manualAssets);
  await enqueueAll('watchlist_item', watchlistItems);
  // workout_session / workout_set / study_session are intentionally never
  // enqueued here — those tables are consumer-read-only for NCC per the
  // suite data contract (LimeLog/StudyDesk own them).
  await enqueueAll('task', tasks);
  await enqueueAll('course', courses);
  await enqueueAll('grade', grades);
  await enqueueAll('goal', goals);
  await enqueueAll('stock_sale', stockSales);
  await enqueueAll('portfolio_cash_entry', cashEntries);
  await enqueueAll('work_quality_log', workQualityLogs);

  // Stamp user_id for later use isn't needed since the push handler reads
  // userId from the current session.
  void userId;
  return count;
}

// ============================================================================
// Full sync: push then pull. Returns combined stats.
// ============================================================================
export async function fullSync(userId: string): Promise<{ push: PushResult; pull: PullResult }> {
  const push = await pushQueue(userId);
  const pull = await pullAll(userId);
  return { push, pull };
}

// ============================================================================
// Heuristic: does local data exist? Used to gate the adoption prompt.
// ============================================================================
export async function hasLocalData(): Promise<boolean> {
  // Counts only pending (never-synced) rows so a 'synced' row hydrated from
  // another user on a shared device doesn't trip the adoption prompt — see
  // adoptLocalData. workoutSessions/studySessions are dropped from the
  // heuristic entirely: NCC doesn't own those tables.
  const counts = await Promise.all([
    db.transactions.filter((r) => r.syncStatus === 'pending').count(),
    db.budgetCategories.count(), // no syncStatus field
    db.portfolioHoldings.count(), // no syncStatus field
    db.tasks.filter((r) => r.syncStatus === 'pending').count(),
    db.courses.count(), // no syncStatus field
    db.grades.filter((r) => r.syncStatus === 'pending').count(),
  ]);
  return counts.some((c) => c > 0);
}
