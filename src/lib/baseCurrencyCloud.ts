// v1.21 (NCC#248): the base currency is an account setting once anyone has
// converted. `user_preferences.ncc_base_currency` holds it (migration
// 20261114_v121_ncc_base_currency.sql).
//
// Why: the conversion (lib/currencyRebase.ts, NCC#244) rewrites the synced
// amounts on the server, but the base currency label lived only on the device.
// Every other device then showed converted numbers under its old label, and a
// conversion there converted them a second time.
//
// Rules:
//   - NULL (never converted) changes nothing: devices keep their own setting.
//   - A conversion first CLAIMS the column, conditionally: only while it still
//     holds the currency being converted from (or NULL). A device that lost the
//     race adopts the winner's currency and converts nothing.
//   - Before every sync (useSyncStore) a device adopts the account currency if
//     its own differs. The synced rows are already converted, so it converts
//     nothing on the server. Its own not-yet-pushed rows still hold amounts in
//     the old currency, so those are converted locally first.
//
// Loaded on demand (sync and Settings only), never in the startup bundle.
import { supabase } from './supabase';
import { db } from '../db/database';
import { ensureFxRates } from '../api/fxRates';
import { listPending } from '../db/syncQueue';
import { applyCurrencyRebase, planCurrencyRebase } from './currencyRebase';
import { isSupportedCurrency, useSettingsStore } from '../store/useSettingsStore';

export type CloudRead =
  | { kind: 'ok'; code: string | null }
  | { kind: 'unsupported' } // migration not applied yet
  | { kind: 'error' }; // offline, timeout, anything else

export type ClaimResult =
  | { kind: 'ok' }
  | { kind: 'conflict'; current: string }
  | { kind: 'unsupported' }
  | { kind: 'error' };

/** The column is missing (42703 from Postgres, PGRST204 from PostgREST's
 *  schema cache) until the migration is applied. */
export function isMissingColumn(err: { code?: string; message?: string } | null | undefined): boolean {
  if (!err) return false;
  if (err.code === '42703' || err.code === 'PGRST204') return true;
  return /ncc_base_currency/.test(err.message ?? '') && /does not exist|could not find/i.test(err.message ?? '');
}

export async function readCloudBaseCurrency(userId: string): Promise<CloudRead> {
  try {
    const { data, error } = await supabase
      .from('user_preferences')
      .select('ncc_base_currency')
      .eq('user_id', userId)
      // Runs before every sync: a hung network must not stall the sync.
      .abortSignal(AbortSignal.timeout(5_000))
      .maybeSingle();
    if (error) return isMissingColumn(error) ? { kind: 'unsupported' } : { kind: 'error' };
    const code = (data as { ncc_base_currency?: string | null } | null)?.ncc_base_currency ?? null;
    return { kind: 'ok', code: code && isSupportedCurrency(code) ? code : null };
  } catch {
    return { kind: 'error' };
  }
}

/** Set the account currency `from` → `to`, only if nobody else changed it
 *  first. Conditional on the row's current value, so two devices converting at
 *  once cannot both win. */
export async function claimCloudBaseCurrency(userId: string, from: string, to: string): Promise<ClaimResult> {
  const read = await readCloudBaseCurrency(userId);
  if (read.kind !== 'ok') return read;
  if (read.code !== null && read.code !== from) return { kind: 'conflict', current: read.code };
  const now = new Date().toISOString();
  try {
    if (read.code === null) {
      // No row, or a row that never held a currency. Insert-or-claim-null in
      // one step is not expressible through PostgREST, so: try the update on a
      // NULL value first; if it touched nothing, insert (a racing insert gets a
      // 23505 and is treated as a conflict).
      const upd = await supabase
        .from('user_preferences')
        .update({ ncc_base_currency: to, updated_at: now })
        .eq('user_id', userId)
        .is('ncc_base_currency', null)
        .select('user_id');
      if (upd.error) return isMissingColumn(upd.error) ? { kind: 'unsupported' } : { kind: 'error' };
      if ((upd.data ?? []).length > 0) return { kind: 'ok' };
      const ins = await supabase
        .from('user_preferences')
        .insert({ user_id: userId, ncc_base_currency: to, updated_at: now });
      if (!ins.error) return { kind: 'ok' };
      if (isMissingColumn(ins.error)) return { kind: 'unsupported' };
      return conflictFromReread(userId);
    }
    const upd = await supabase
      .from('user_preferences')
      .update({ ncc_base_currency: to, updated_at: now })
      .eq('user_id', userId)
      .eq('ncc_base_currency', from)
      .select('user_id');
    if (upd.error) return isMissingColumn(upd.error) ? { kind: 'unsupported' } : { kind: 'error' };
    if ((upd.data ?? []).length > 0) return { kind: 'ok' };
    return conflictFromReread(userId);
  } catch {
    return { kind: 'error' };
  }
}

async function conflictFromReread(userId: string): Promise<ClaimResult> {
  const again = await readCloudBaseCurrency(userId);
  if (again.kind !== 'ok') return again;
  return again.code ? { kind: 'conflict', current: again.code } : { kind: 'error' };
}

/** Adopt the account currency on this device if it differs. Returns the
 *  currency adopted, or null when nothing changed. Never throws. */
export async function adoptCloudBaseCurrency(userId: string): Promise<string | null> {
  const read = await readCloudBaseCurrency(userId);
  if (read.kind !== 'ok' || read.code === null) return null;
  const settings = useSettingsStore.getState();
  const from = settings.baseCurrency;
  const to = read.code;
  if (to === from || !isSupportedCurrency(to)) return null;

  // This device's unsynced edits still hold amounts in `from`. Convert just
  // those, so they do not land on the server as `to` amounts. The synced rows
  // arrive already converted with the pull that follows.
  const pendingIds = new Set(
    (await listPending())
      .filter((q) => q.entityType === 'transaction' || q.entityType === 'budget_category' || q.entityType === 'recurring_rule')
      .map((q) => q.entityId),
  );
  if (pendingIds.size > 0) {
    const [transactions, budgets, rules] = await Promise.all([
      db.transactions.filter((t) => pendingIds.has(t.id)).toArray(),
      db.budgetCategories.filter((b) => pendingIds.has(b.id)).toArray(),
      db.recurringRules.filter((r) => pendingIds.has(r.id)).toArray(),
    ]);
    const fx = await ensureFxRates();
    const plan = planCurrencyRebase({ from, to, rates: fx?.rates ?? null, transactions, budgets, rules, userId });
    // No rate offline: adopt anyway (the label must follow the account), and
    // leave these few rows as they are rather than block every sync. Logged so
    // it can be traced.
    if (plan) await applyCurrencyRebase(plan);
    else console.warn(`[currency] adopted ${to} without converting ${pendingIds.size} unsynced row(s): no ${from}→${to} rate`);
  }
  await settings.setBaseCurrency(to as Parameters<typeof settings.setBaseCurrency>[0]);
  return to;
}
