// GDPR data-subject rights — Article 20 (portability) and Article 17 (erasure).
//
// Ported from StudyDesk's src/lib/dataRights.js, which shipped these first. The
// suite shares one account and one database, so the Edge Function and the
// cascade behaviour are identical; only the local-data shape differs.
//
// Export works signed in or as a guest: a guest's data lives only on the device,
// and it is still their data. Deletion only means anything when there is a
// server-side account to delete.

import { db } from '../db/database';
import { readStoredSession, supabase } from './supabase';
import { selectAll } from './selectAll';
import { exportAllowed, GUEST_ID } from './adoptionGate';
import { readLastUserId } from './adoptionChoice';
import { saveTextFile } from './saveFile';
import '../i18n/lazy/dataRights'; // settings.* and crash.* copy, loaded with this module

const EXPORT_SCHEMA_VERSION = 1;

// Tables deliberately left out of the export, with the reason. Everything else
// is included by enumeration rather than by a hand-written list — a list would
// silently omit any table added later, and an incomplete Article 20 export is
// worse than a slightly noisy one.
const EXCLUDED: Record<string, string> = {
  apiCache: 'Cached third-party market data (prices, FX). Not your data, and it '
    + 'is re-fetched on demand.',
  insightsScores: 'Derived scores recomputed from the data below.',
  // v1.21.1 (limecore#114): pending uploads are copies of rows already in the
  // export, and an account switch can leave another account's items here.
  syncQueue: 'Changes waiting to upload. Copies of rows already in this export.',
};

/**
 * v1.21.1 (limecore#114): the preferences that go into the export, by name.
 * The export used to copy every stored key except API keys, which included
 * the sign-in session, the suite sign-in bundle and the PIN. Now only known
 * preference keys go in; anything new stays out until it is added here.
 * Never add auth.pin*, a session or token key, or suite.sso.*.
 */
export const EXPORT_SETTING_KEYS: readonly string[] = [
  'auth.autoLockMin',
  'auth.biometricEnabled',
  'habits.reminderSlots',
  'limecore_lang',
  'ncc.lifeProfile',
  'ncc.onboarded',
  'nexus.theme',
  'nexus-sidebar',
  'referral_source',
  'studies.gradeMode',
];
export const EXPORT_SETTING_PREFIXES: readonly string[] = ['settings.', 'fitness.'];

// Second line of defence: a value shaped like a credential is dropped even
// under an allowed key (a JWT, or a long token-like string).
const CREDENTIAL_SHAPED = /eyJ[\w-]{8,}\.[\w-]{8,}|"(access|refresh)_token"|^[A-Za-z0-9_-]{40,}$/;

export function exportableSetting(key: string, value: string | null): boolean {
  const allowed = EXPORT_SETTING_KEYS.includes(key) || EXPORT_SETTING_PREFIXES.some((p) => key.startsWith(p));
  return allowed && !(value != null && CREDENTIAL_SHAPED.test(value));
}

async function exportSettings(): Promise<Record<string, unknown>> {
  const settings: Record<string, unknown> = {};
  // The device keeps preferences in both stores: Capacitor Preferences on
  // native, and localStorage (some screens, and every key on the web).
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      const v = k == null ? null : localStorage.getItem(k);
      if (k != null && exportableSetting(k, v)) settings[k] = v;
    }
  } catch {
    /* no localStorage */
  }
  try {
    const { Preferences } = await import('@capacitor/preferences');
    const { keys } = await Preferences.keys();
    for (const k of keys) {
      const { value } = await Preferences.get({ key: k });
      if (exportableSetting(k, value)) settings[k] = value;
    }
  } catch {
    /* no Capacitor bridge (web dev) */
  }
  return settings;
}

interface ExportPayload {
  schemaVersion: number;
  exportedAt: string;
  application: string;
  account: Record<string, unknown>;
  counts: Record<string, number>;
  excluded: Record<string, string>;
  data: Record<string, unknown[]>;
  server?: Record<string, unknown[] | { error: string }>;
  /** v1.22 (limecore#88): the user's uploaded files, listed by bucket. */
  files?: Record<string, unknown[] | { error: string }>;
  settings: Record<string, unknown>;
}

/**
 * v1.22 (limecore#88) — everything the account holds on the server, in all
 * three apps. One account spans NCC, StudyDesk and LimeLog, and the privacy
 * policy says "Export my data" from any of them covers all of them. This used
 * to read only feedback and error reports (the two things that exist only on
 * the server), so the export left out StudyDesk's notes, timetable and files,
 * LimeLog's body metrics, and the account's preferences, profile, supporter
 * status and activity log.
 *
 * Each table is read as the user, so RLS decides what comes back; `user_id`
 * filters rows the user can see but does not own (a task shared with them)
 * out of their export. Tables that only rate-limit or deny direct access
 * (ai_rate_limits, share_invite_rate_limits) hold nothing to export and are
 * left out. A table the account cannot read records the error instead, so an
 * incomplete export says so.
 */
// v1.18.1 (NCC#158): the columns a signed-in user may read. `feedback` lost
// its table-wide SELECT in the v1.17 status-columns migration; only these are
// granted, so `select('*')` (and a filter on user_id) failed as a whole and
// the export held "permission denied" instead of the user's feedback. RLS
// already limits the rows to the user's own, so no user_id filter is needed.
// `client_errors` still has every column granted, user_id included.
const FEEDBACK_EXPORT_COLUMNS = 'id, app, app_version, category, rating, message, status, shipped_in, created_at';

interface ServerTable {
  table: string;
  /** Default `*`. Only these columns are granted on some tables. */
  columns?: string;
  /** Which column names the user: `user_id` (default), `id` (profiles), or
   *  none, when RLS alone decides (audit_log, feedback). */
  owner?: 'user_id' | 'id' | 'none';
  /** Tables without an `id` column cannot use the id-keyed pager; they are
   *  read in ranges ordered by these columns. */
  orderBy?: string[];
}

export const SERVER_TABLES: readonly ServerTable[] = [
  // Account
  { table: 'profiles', owner: 'id' },
  { table: 'user_preferences', orderBy: ['user_id'] },
  { table: 'supporter_entitlements', orderBy: ['user_id'] },
  // Only these columns are granted; the verification code itself is not.
  { table: 'kofi_alt_emails', columns: 'email, verified_at, code_expires_at, last_sent_at, user_id', orderBy: ['email'] },
  { table: 'app_opens', orderBy: ['opened_on', 'app'] },
  { table: 'audit_log', owner: 'none' },
  { table: 'feedback', columns: FEEDBACK_EXPORT_COLUMNS, owner: 'none' },
  { table: 'client_errors' },
  // Nexus Command Center
  { table: 'transactions' },
  { table: 'budget_categories' },
  { table: 'budget_category_shares', orderBy: ['user_id'] },
  { table: 'manual_assets' },
  { table: 'portfolio_holdings' },
  { table: 'portfolio_lots' },
  { table: 'stock_sales' },
  { table: 'portfolio_cash_entries' },
  { table: 'watchlist_items' },
  { table: 'recurring_rules' },
  { table: 'goals' },
  { table: 'tasks' },
  { table: 'task_shares', orderBy: ['user_id'] },
  { table: 'habits' },
  { table: 'habit_completions' },
  { table: 'braindump_entries' },
  { table: 'work_quality_logs' },
  // StudyDesk
  { table: 'subjects' },
  { table: 'grades' },
  { table: 'study_sessions' },
  { table: 'assignments' },
  { table: 'assignment_attachments' },
  { table: 'exams' },
  { table: 'study_actions' },
  { table: 'notebook_entries' },
  { table: 'notebook_attachments' },
  { table: 'academic_terms' },
  { table: 'timetable_entries' },
  { table: 'lesson_attendance' },
  { table: 'planned_sessions' },
  { table: 'readings' },
  { table: 'progress_counters' },
  { table: 'progress_counter_days' },
  { table: 'commitments' },
  { table: 'focus_timers', orderBy: ['user_id'] },
  // LimeLog
  { table: 'workout_sessions' },
  { table: 'workout_sets' },
  { table: 'exercise_prs' },
  { table: 'body_metrics' },
];

/** Kept for callers of the v1.16 name: the two server-only tables. */
export const SERVER_ONLY_TABLES = ['feedback', 'client_errors'] as const;


const RANGE = 1000;

/** Reads a table without an `id` column in ordered ranges. */
async function readRanged(t: ServerTable, userId: string): Promise<unknown[]> {
  const rows: unknown[] = [];
  for (let from = 0; ; from += RANGE) {
    let q = supabase.from(t.table).select(t.columns ?? '*').eq('user_id', userId);
    for (const col of t.orderBy ?? []) q = q.order(col, { ascending: true });
    const { data, error } = await q.range(from, from + RANGE - 1);
    if (error) throw error;
    rows.push(...(data ?? []));
    if (!data || data.length < RANGE) return rows;
  }
}

async function readTable(t: ServerTable, userId: string): Promise<unknown[]> {
  if (t.orderBy) return readRanged(t, userId);
  const owner = t.owner ?? 'user_id';
  const { data, error } = await selectAll(supabase, t.table, {
    ...(t.columns ? { columns: t.columns } : {}),
    ...(owner === 'none' ? {} : { filter: (q) => q.eq(owner, userId) }),
  });
  if (error) throw error;
  return data ?? [];
}

/** v1.22 (limecore#88) — the user's uploaded files, by bucket: path, size and
 *  date of each object under their own folder (every storage policy scopes a
 *  user to `<user_id>/`). A listing, not the files: they are downloaded in
 *  StudyDesk, which owns them. */
export const STORAGE_BUCKETS = ['avatars', 'notebook', 'assignment-attachments'] as const;

interface StorageEntry { path: string; size: number | null; createdAt: string | null; contentType: string | null }

async function listFolder(bucket: string, prefix: string, out: StorageEntry[], depth = 0): Promise<void> {
  if (depth > 4) return;
  for (let offset = 0; ; offset += RANGE) {
    const { data, error } = await supabase.storage.from(bucket).list(prefix, { limit: RANGE, offset });
    if (error) throw error;
    for (const o of data ?? []) {
      const path = `${prefix}/${o.name}`;
      // A folder has no id and no metadata; recurse into it.
      if (!o.id) await listFolder(bucket, path, out, depth + 1);
      else
        out.push({
          path,
          size: (o.metadata as { size?: number } | null)?.size ?? null,
          createdAt: o.created_at ?? null,
          contentType: (o.metadata as { mimetype?: string } | null)?.mimetype ?? null,
        });
    }
    if (!data || data.length < RANGE) return;
  }
}

export async function serverFiles(userId: string): Promise<Record<string, StorageEntry[] | { error: string }>> {
  const out: Record<string, StorageEntry[] | { error: string }> = {};
  for (const bucket of STORAGE_BUCKETS) {
    try {
      const entries: StorageEntry[] = [];
      await listFolder(bucket, userId, entries);
      out[bucket] = entries;
    } catch (e) {
      out[bucket] = { error: (e as Error).message };
    }
  }
  return out;
}

export async function serverOnlyData(userId: string): Promise<Record<string, unknown[] | { error: string }>> {
  const out: Record<string, unknown[] | { error: string }> = {};
  for (const t of SERVER_TABLES) {
    try {
      out[t.table] = await readTable(t, userId);
    } catch (e) {
      out[t.table] = { error: (e as Error).message ?? String(e) };
    }
  }
  return out;
}

/**
 * Everything we hold about the user, as a plain object.
 *
 * Built from the local database rather than by re-reading the server: local
 * state is the union of what synced down and what has not synced up yet, so it
 * is the more complete picture. Article 20 asks for "structured, commonly used
 * and machine-readable" — JSON qualifies, and unlike CSV it carries the nested
 * shape without inventing a flattening the user then has to undo.
 *
 * Soft-deleted rows are included. They still exist in the database, so omitting
 * them would make the export a misleading account of what we hold.
 */
async function buildExport(user: { id: string; email?: string } | null): Promise<ExportPayload> {
  const data: Record<string, unknown[]> = {};
  const counts: Record<string, number> = {};

  for (const table of db.tables) {
    if (table.name in EXCLUDED) continue;
    const rows = await table.toArray();
    data[table.name] = rows;
    counts[table.name] = rows.length;
  }

  const settings = await exportSettings();

  return {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    application: 'Nexus Command Center',
    account: user
      ? { email: user.email ?? null, userId: user.id }
      : { mode: 'guest', note: 'No account — this data has never left the device.' },
    counts,
    excluded: EXCLUDED,
    data,
    ...(user ? { server: await serverOnlyData(user.id), files: await serverFiles(user.id) } : {}),
    settings,
  };
}

/** v1.21.1 (limecore#103): save the export as a .json file. On Android the
 *  system picker writes it (lib/saveFile.ts). Returns the filename once the
 *  file is written, or null when the user cancelled. Throws on failure. */
export async function downloadExport(user: { id: string; email?: string } | null): Promise<string | null> {
  // v1.18.1 — account switch: the adoption choice comes first. Until it is
  // made, the data here may be another account's kept data.
  if (!exportAllowed(user?.id)) throw new Error('adoption choice pending');
  const payload = await buildExport(user);
  const json = JSON.stringify(payload, null, 2);
  const name = `nexus-export-${new Date().toISOString().slice(0, 10)}.json`;
  return (await saveTextFile(name, json)) ? name : null;
}

/**
 * Erase the account and everything attached to it.
 *
 * Deleting the auth user is sufficient: every user-owned table declares
 * `REFERENCES auth.users(id) ON DELETE CASCADE`, so the rows go with it. The
 * deletion runs in the shared `delete-account` Edge Function because
 * `auth.admin.deleteUser` needs the service-role key, which must never ship in
 * a client bundle. The function authenticates the caller by their own JWT and
 * deletes only that user, so it cannot be aimed at anyone else.
 *
 * It is deliberately the same function StudyDesk calls: one account spans all
 * three apps, so deleting from any of them must erase everything, not just the
 * calling app's tables.
 *
 * v1.21.1 (limecore#102): "guest or account" is decided from the device, not
 * from getSession() alone. An expired session that cannot be refreshed (or a
 * getSession error) used to look exactly like a guest: the device was wiped,
 * the server account survived, and the screen said it was done. Now:
 * - an account is recorded here (a stored session, or a last signed-in user
 *   that is not the guest) but there is no usable session: refuse, wipe
 *   nothing, and say why;
 * - a real guest: wipe the device and say there was no account;
 * - the server deleted the account: wipe the device, including the stored
 *   auth session (signOut local scope, so it never needs the network).
 *
 * v1.21.1 (limecore#124): the session check is bounded. Offline with an
 * expired session, getSession() keeps retrying its refresh and never
 * returns, so the refusal above never showed and the delete stayed pending,
 * free to go ahead minutes later once the network came back. Offline is now
 * decided before asking (a guest can still wipe; an account is refused), and
 * a getSession that takes longer than SESSION_CHECK_MS counts as failed.
 */
export const SESSION_CHECK_MS = 8_000;
export type DeleteResult =
  | { deleted: 'account' }
  | { deleted: 'local' }
  | { deleted: 'nothing'; reason: 'signed-out' };

export async function deleteAccount({ clearLocal }: { clearLocal: () => Promise<void> }): Promise<DeleteResult> {
  let session = null;
  let sessionError = false;
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
  if (!offline) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const res = await Promise.race([
        supabase.auth.getSession(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('session check timed out')), SESSION_CHECK_MS);
        }),
      ]);
      session = res.data.session;
      sessionError = !!res.error;
    } catch {
      sessionError = true;
    } finally {
      clearTimeout(timer);
    }
  }

  if (!session) {
    const last = readLastUserId();
    const accountHere = sessionError
      || (await readStoredSession()) !== null
      || (last !== null && last !== GUEST_ID);
    // An account exists but cannot be reached right now. Deleting only the
    // device copy would leave the account alive while saying it was erased.
    if (accountHere) return { deleted: 'nothing', reason: 'signed-out' };
    // Guest: there is no server-side account. Clearing the device is the whole
    // of the erasure.
    await clearLocal();
    return { deleted: 'local' };
  }

  const { error } = await supabase.functions.invoke('delete-account', {
    body: { confirm: true },
  });
  if (error) throw new Error(error.message || 'Account deletion failed');

  try {
    // Local scope: the user row is already gone, so a global sign-out would
    // only fail; this removes the stored session (Preferences on Android,
    // which the local wipe does not reach) without a request.
    await supabase.auth.signOut({ scope: 'local' });
  } catch {
    /* not fatal: the account is deleted either way */
  }
  await clearLocal();
  return { deleted: 'account' };
}
