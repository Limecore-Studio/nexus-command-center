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
import { supabase } from './supabase';
import { selectAll } from './selectAll';
import { exportAllowed } from './adoptionGate';

const EXPORT_SCHEMA_VERSION = 1;

// Tables deliberately left out of the export, with the reason. Everything else
// is included by enumeration rather than by a hand-written list — a list would
// silently omit any table added later, and an incomplete Article 20 export is
// worse than a slightly noisy one.
const EXCLUDED: Record<string, string> = {
  apiCache: 'Cached third-party market data (prices, FX). Not your data, and it '
    + 'is re-fetched on demand.',
  insightsScores: 'Derived scores recomputed from the data below.',
};

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

export async function serverOnlyData(userId: string): Promise<Record<string, unknown[] | { error: string }>> {
  const out: Record<string, unknown[] | { error: string }> = {};
  for (const table of SERVER_ONLY_TABLES) {
    try {
      const { data, error } = await selectAll(supabase, table, { filter: (q) => q.eq('user_id', userId) });
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

  let settings: Record<string, unknown> = {};
  try {
    const { Preferences } = await import('@capacitor/preferences');
    const { keys } = await Preferences.keys();
    for (const k of keys) {
      // API keys are the user's own third-party credentials. Round-tripping
      // them through a file in the Downloads folder is a worse outcome than
      // leaving them out, and they are not personal data about the user.
      if (k.startsWith('apikey_')) continue;
      settings[k] = (await Preferences.get({ key: k })).value;
    }
  } catch {
    // Web dev / no Capacitor bridge — fall back to localStorage.
    try {
      settings = Object.fromEntries(
        Object.entries(localStorage).filter(([k]) => !k.startsWith('apikey_')),
      );
    } catch {
      settings = {};
    }
  }

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

/** Trigger a download of the export as a .json file. Returns the filename. */
export async function downloadExport(user: { id: string; email?: string } | null): Promise<string> {
  // v1.18.1 — account switch: the adoption choice comes first. Until it is
  // made, the data here may be another account's kept data.
  if (!exportAllowed(user?.id)) throw new Error('adoption choice pending');
  const payload = await buildExport(user);
  const json = JSON.stringify(payload, null, 2);
  const name = `nexus-export-${new Date().toISOString().slice(0, 10)}.json`;
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick — revoking synchronously can cancel the download on
  // some Android WebView versions before it has started.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return name;
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
 * Local data is cleared regardless of what the server says. A user who asked to
 * be deleted should not find their data still on the device afterwards.
 */
export async function deleteAccount({ clearLocal }: { clearLocal: () => Promise<void> }): Promise<{ deleted: 'local' | 'account' }> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
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
    await supabase.auth.signOut();
  } catch {
    // The user row is already gone, so the sign-out call may fail. Not fatal.
  }
  await clearLocal();
  return { deleted: 'account' };
}
