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
  settings: Record<string, unknown>;
}

/**
 * v1.16 (limecore#16) — the two things we hold that exist ONLY on the server:
 * feedback the user sent, and error reports (kept 90 days). Neither is in the
 * local database, so an export built from it alone would omit them, and the
 * privacy policy (#50) promises the export includes both. Signed-in only; a
 * guest has sent neither. A failed read is recorded in the export rather than
 * dropped, so an incomplete export says so.
 */
export const SERVER_ONLY_TABLES = ['feedback', 'client_errors'] as const;

// v1.18.1 (NCC#158): the columns a signed-in user may read. `feedback` lost
// its table-wide SELECT in the v1.17 status-columns migration; only these are
// granted, so `select('*')` (and a filter on user_id) failed as a whole and
// the export held "permission denied" instead of the user's feedback. RLS
// already limits the rows to the user's own, so no user_id filter is needed.
// `client_errors` still has every column granted, user_id included.
const FEEDBACK_EXPORT_COLUMNS = 'id, app, app_version, category, rating, message, status, shipped_in, created_at';

export async function serverOnlyData(userId: string): Promise<Record<string, unknown[] | { error: string }>> {
  const out: Record<string, unknown[] | { error: string }> = {};
  for (const table of SERVER_ONLY_TABLES) {
    try {
      const { data, error } =
        table === 'feedback'
          ? await selectAll(supabase, table, { columns: FEEDBACK_EXPORT_COLUMNS })
          : await selectAll(supabase, table, { filter: (q) => q.eq('user_id', userId) });
      out[table] = error ? { error: error.message } : (data ?? []);
    } catch (e) {
      out[table] = { error: (e as Error).message };
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
    ...(user ? { server: await serverOnlyData(user.id) } : {}),
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
 */
export type DeleteResult =
  | { deleted: 'account' }
  | { deleted: 'local' }
  | { deleted: 'nothing'; reason: 'signed-out' };

export async function deleteAccount({ clearLocal }: { clearLocal: () => Promise<void> }): Promise<DeleteResult> {
  let session = null;
  let sessionError: boolean;
  try {
    const res = await supabase.auth.getSession();
    session = res.data.session;
    sessionError = !!res.error;
  } catch {
    sessionError = true;
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
