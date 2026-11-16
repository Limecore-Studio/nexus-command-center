// v1.21 (NCC#248): the base currency is an account setting once anyone has
// converted. `user_preferences.ncc_base_currency` holds it (migration
// 20261114174926_v121_ncc_base_currency.sql, applied to production 2026-11-14).
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
import { applyCurrencyRebase, planCurrencyRebase, type CurrencyRebasePlan } from './currencyRebase';
import { isSupportedCurrency, useSettingsStore, type BaseCurrency } from '../store/useSettingsStore';
import {
  clearConversionMarker,
  readConversionMarker,
  writeConversionMarker,
  type ConversionMarker,
  type ConversionProbe,
} from './currencyConversionMarker';
import type { BudgetCategory, Transaction } from '../types/finance';
import type { RecurringRule } from '../types/recurring';

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

// ---------------------------------------------------------------------------
// v1.21 (NCC#266): the conversion itself, with a way back.
//
// The account claim, the device setting and the row rewrite are three writes
// in three places. The rewrite is one Dexie transaction, so the rows either
// all convert or none do; the other two need undoing by hand. A marker
// (currencyConversionMarker.ts) is written first and cleared last, and while
// it is present no sync runs: resolvePendingConversion finishes or undoes the
// conversion first, so an unconverted ledger never goes up under the new label.

let running = false;

export type ConvertResult =
  | { kind: 'ok' }
  | { kind: 'conflict'; current: string }
  | { kind: 'unsupported' }
  | { kind: 'claimFailed' }
  /** The rewrite failed; the device and the account are back on `from`. */
  | { kind: 'failed' }
  /** The rewrite failed and the account could not be set back yet (offline).
   *  The marker stays, and the next sync sets it back before anything else. */
  | { kind: 'failedPending' };

/** A row the plan changes, so a later check can tell whether the rewrite
 *  committed. Null when no row changes (every amount is 0, or the rate rounds
 *  to 1): then a committed and an uncommitted rewrite look the same. */
export function conversionProbe(
  plan: CurrencyRebasePlan,
  originals: { transactions: Transaction[]; budgets: BudgetCategory[]; rules: RecurringRule[] },
): ConversionProbe | null {
  const tx = new Map(originals.transactions.map((t) => [t.id, t.amount]));
  for (const t of plan.transactions) {
    const o = tx.get(t.id);
    if (o !== undefined && o !== t.amount) return { table: 'transactions', id: t.id, original: o, converted: t.amount };
  }
  const bu = new Map(originals.budgets.map((b) => [b.id, b.monthlyLimit]));
  for (const b of plan.budgets) {
    const o = bu.get(b.id);
    if (o !== undefined && o !== b.monthlyLimit)
      return { table: 'budgetCategories', id: b.id, original: o, converted: b.monthlyLimit };
  }
  const ru = new Map(originals.rules.map((r) => [r.id, ruleAmount(r)]));
  for (const r of plan.rules) {
    const o = ru.get(r.id);
    const c = ruleAmount(r);
    if (o !== undefined && c !== undefined && o !== c)
      return { table: 'recurringRules', id: r.id, original: o, converted: c };
  }
  return null;
}

const asBase = (c: string) => c as BaseCurrency;
/** Only `transaction` and `cash_deposit` rules carry an amount the
 *  conversion touches (currencyRebase.ts). */
const ruleAmount = (r: RecurringRule): number | undefined => (r.template as { amount?: number }).amount;

/** Claim the account, switch the device, rewrite the rows; on a failed
 *  rewrite, put the device and the account back. */
export async function convertBaseCurrency(input: {
  from: string;
  to: string;
  userId: string | null;
  plan: CurrencyRebasePlan;
  probe: ConversionProbe | null;
}): Promise<ConvertResult> {
  const { from, to, userId, plan, probe } = input;
  running = true;
  try {
    const marker: ConversionMarker = { from, to, userId, claimed: false, probe };
    writeConversionMarker(marker);
    if (userId) {
      const claim = await claimCloudBaseCurrency(userId, from, to);
      if (claim.kind !== 'ok') {
        // Nothing has changed yet.
        clearConversionMarker();
        return claim.kind === 'error' ? { kind: 'claimFailed' } : claim;
      }
      marker.claimed = true;
      writeConversionMarker(marker);
    }
    try {
      // Currency first, then the rows: a push that picks up the converted
      // rows must label them with the new currency. (No push runs meanwhile:
      // the marker holds every sync.)
      await useSettingsStore.getState().setBaseCurrency(asBase(to));
      await applyCurrencyRebase(plan);
    } catch (e) {
      console.warn('[currency] conversion failed, undoing:', (e as Error).message);
      return (await undoConversion(marker)) ? { kind: 'failed' } : { kind: 'failedPending' };
    }
    clearConversionMarker();
    return { kind: 'ok' };
  } finally {
    running = false;
  }
}

/** Device back to `from`; account back to `from` if it still says `to`.
 *  True when nothing is left to undo (the marker is cleared). */
async function undoConversion(m: ConversionMarker): Promise<boolean> {
  try {
    await useSettingsStore.getState().setBaseCurrency(asBase(m.from));
  } catch {
    return false;
  }
  if (m.userId) {
    // Checked even when the claim was not confirmed: its request may have
    // reached the server while the reply was lost.
    const read = await readCloudBaseCurrency(m.userId);
    if (read.kind === 'error') return false;
    if (read.kind === 'ok' && read.code === m.to) {
      const back = await claimCloudBaseCurrency(m.userId, m.to, m.from);
      // A conflict means someone has changed it since: theirs stands, and the
      // adopt step that follows picks it up.
      if (back.kind === 'error') return false;
    }
  }
  clearConversionMarker();
  return true;
}

/** Did the rewrite commit? A row that holds neither value was edited or
 *  deleted after a crash; it can no longer tell, and is taken as committed,
 *  because the device's own edits since then were made under the new label. */
async function rewriteCommitted(p: ConversionProbe | null): Promise<boolean> {
  if (!p) return true;
  const row = await db.table(p.table).get(p.id);
  if (!row) return true;
  const amount =
    p.table === 'transactions'
      ? (row as Transaction).amount
      : p.table === 'budgetCategories'
        ? (row as BudgetCategory).monthlyLimit
        : ruleAmount(row as RecurringRule);
  return amount !== p.original;
}

/** The currency step of every full sync (useSyncStore). False holds the sync. */
export async function beforeSync(userId: string): Promise<boolean> {
  if (!(await resolvePendingConversion())) return false;
  try {
    await adoptCloudBaseCurrency(userId);
  } catch (e) {
    console.warn('[currency] account currency check failed:', (e as Error).message);
  }
  return true;
}

/** Run before any sync. True when the sync may go ahead: no conversion is
 *  pending, or the pending one was finished or undone. False while one is
 *  running here, or while the account cannot be set back yet. */
export async function resolvePendingConversion(): Promise<boolean> {
  if (running) return false;
  const m = readConversionMarker();
  if (!m) return true;
  try {
    if (await rewriteCommitted(m.probe)) {
      await useSettingsStore.getState().setBaseCurrency(asBase(m.to));
      clearConversionMarker();
      return true;
    }
    return await undoConversion(m);
  } catch (e) {
    console.warn('[currency] pending conversion not resolved:', (e as Error).message);
    return false;
  }
}
