// v1.20 Block A (NCC#221, limecore#68) — live sync v2: the hint protocol.
//
// Every signed-in device joins the private Realtime topic `user:<uid>`. After
// a successful push it broadcasts one `changed` event per table it wrote, and
// the other devices pull just those tables. The payload names tables, never
// rows: the data always comes from an RLS-scoped pull, so a hint can make a
// device pull early but can never put anything on its screen.
//
//     { app: 'ncc', table: 'transactions', at: <epoch ms>, device: <id> }
//
// StudyDesk and LimeLog speak the same protocol on the same topic; their hints
// for `subjects` / `grades` / `study_sessions` / `workout_sessions` reach NCC
// here. A hint for a table NCC does not pull (a StudyDesk assignment) is
// ignored. Old builds never join the topic and keep postgres_changes plus the
// return-to-window sync, so nothing changes for them.

import type { SyncQueueItem } from '../db/database';

export const HINT_EVENT = 'changed';
export const HINT_APP = 'ncc';

/** The private topic for a user. Realtime Authorization only lets the user's
 *  own JWT join or send on it (realtime.messages RLS, limecore#68). */
export const hintTopic = (userId: string): string => `user:${userId}`;

/** Every table `pullAll` reads, and so every table a hint can make NCC pull. */
export const PULLED_TABLES: ReadonlySet<string> = new Set([
  'transactions', 'budget_categories', 'portfolio_holdings', 'portfolio_lots',
  'manual_assets', 'watchlist_items', 'subjects', 'grades', 'study_sessions',
  'workout_sessions', 'workout_sets', 'tasks', 'goals', 'habits', 'habit_completions',
  'body_metrics', 'stock_sales', 'portfolio_cash_entries', 'work_quality_logs',
  'braindump_entries', 'recurring_rules',
]);

/** Queue entity type → the table its push writes. App opens and feedback are
 *  absent: no device shows them, so there is nothing to announce. So are the
 *  workout and study-session types, which NCC drops rather than pushes. */
export const ENTITY_TABLES: Partial<Record<SyncQueueItem['entityType'], string>> = {
  transaction: 'transactions',
  budget_category: 'budget_categories',
  portfolio_holding: 'portfolio_holdings',
  portfolio_lot: 'portfolio_lots',
  stock_sale: 'stock_sales',
  portfolio_cash_entry: 'portfolio_cash_entries',
  manual_asset: 'manual_assets',
  watchlist_item: 'watchlist_items',
  goal: 'goals',
  task: 'tasks',
  course: 'subjects',
  grade: 'grades',
  braindump_entry: 'braindump_entries',
  habit: 'habits',
  habit_completion: 'habit_completions',
  work_quality_log: 'work_quality_logs',
  recurring_rule: 'recurring_rules',
};

/** This page's id. `broadcast.self: false` already keeps a channel's own sends
 *  from coming back to it; the id covers a second channel instance in the same
 *  page (a rejoin racing the old one). */
export const DEVICE_ID: string = (() => {
  try {
    return crypto.randomUUID();
  } catch {
    return `d-${Math.random().toString(36).slice(2)}`;
  }
})();

export interface HintPayload {
  app?: string;
  table?: string;
  at?: number;
  device?: string;
}

/** The tables a hint asks NCC to pull, or [] for one to ignore: its own echo,
 *  malformed, or a table NCC does not hold. */
export function tablesFromHint(payload: unknown, ownDevice: string = DEVICE_ID): string[] {
  if (!payload || typeof payload !== 'object') return [];
  const p = payload as HintPayload;
  if (p.device && p.device === ownDevice) return [];
  return typeof p.table === 'string' && PULLED_TABLES.has(p.table) ? [p.table] : [];
}

/** Rejoin delay after the n-th consecutive failure: 1 s, 2 s, 4 s … 30 s. */
export function backoffMs(attempt: number): number {
  return Math.min(30_000, 1000 * 2 ** Math.max(0, attempt));
}

/** Collects table names over a short window and hands them over as one batch,
 *  so a burst of hints costs one pull rather than one per hint. */
export function createTableBatcher(flush: (tables: string[]) => void, windowMs: number) {
  let pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    add(tables: Iterable<string>) {
      for (const t of tables) pending.add(t);
      if (timer || pending.size === 0) return;
      timer = setTimeout(() => {
        timer = null;
        const batch = [...pending];
        pending = new Set();
        flush(batch);
      }, windowMs);
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
      pending = new Set();
    },
  };
}
