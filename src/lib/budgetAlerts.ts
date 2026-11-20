// Budget threshold alerts.
//
// Fires a notification when monthly spend on a category crosses 80% or 100%
// of its cap. Detection is purely local — no backend involvement — and runs:
//
//   • Every time a transaction is added/updated/deleted (in useFinanceStore)
//   • Once on app start (in AppShell after stores load) so a threshold that
//     was crossed while the app was closed still surfaces on next open
//
// De-dupe strategy:
//   localStorage key  nexus.notif.budget.<categoryId>.<YYYY-MM>
//   value             "80" | "100"
//
//   The value is the highest tier already alerted this month. We only fire
//   a tier higher than what's recorded. The key is automatically scoped to
//   the current month (new month → key changes → reset).
//
//   If spend drops back below 80% (user deletes a big expense), we wipe the
//   tracker so a subsequent re-cross fires again. Without that, the user
//   could shuffle transactions and miss real new alerts.
//
// Notification IDs live in 3000-3099. Each category hashes to a slot via
// (sum of charcodes) % 50; the threshold tier (80=0, 100=1) is the LSB so
// the two tiers for a category get adjacent IDs. Collisions across many
// categories mean one pending alert may overwrite another — acceptable
// because the localStorage tracker is the actual source of truth for
// "have we alerted yet", not the notification ID.

import type { Transaction, BudgetCategory } from '../types/finance';
import { scheduleNotification, ID_RANGES } from './notifications';
import { useSettingsStore } from '../store/useSettingsStore';
import { hashSlot, slotAllocator } from './notifSlots';

const THRESHOLDS = [80, 100] as const;
type Threshold = (typeof THRESHOLDS)[number];

// v1.22 (NCC#258): a slot per category assigned on this device
// (lib/notifSlots.ts), not a hash modulo 50 that let one category's alert
// replace another's. 50 categories × 2 tiers = 100 ids; past 50, the hash.
const budgetSlots = slotAllocator('budgets.alertSlots', 50);
async function budgetNotifId(categoryId: string, threshold: Threshold): Promise<number> {
  const slot = (await budgetSlots.slotOf(categoryId)) ?? hashSlot(categoryId, 50);
  const tier = threshold === 80 ? 0 : 1;
  return ID_RANGES.budgets.base + slot * 2 + tier;
}

function lastFiredKey(categoryId: string, yearMonth: string): string {
  return `nexus.notif.budget.${categoryId}.${yearMonth}`;
}

function currentYearMonth(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

/** Compute current-month spend for one category (expenses only). */
function spentThisMonth(
  transactions: Transaction[],
  categoryId: string,
  yearMonth: string,
): number {
  let total = 0;
  for (const t of transactions) {
    if (t.type !== 'expense') continue;
    if (t.categoryId !== categoryId) continue;
    if (!t.date.startsWith(yearMonth)) continue;
    total += t.amount;
  }
  return total;
}

// Minimal in-place currency formatter — the budget message body shouldn't
// import the heavyweight Intl formatter just for one string. Two decimals
// when needed, integer when not.
function formatAmount(n: number): string {
  return n % 1 === 0 ? n.toFixed(0) : n.toFixed(2);
}

/**
 * Walk the budget categories, compare current-month spend to each cap, and
 * schedule one notification per category whose tier crossed since the last
 * alert. Idempotent — calling repeatedly is safe; the localStorage tracker
 * prevents re-firing the same tier in the same month.
 *
 * Fire-and-forget: the caller doesn't need to await this. We swallow errors
 * so a misbehaving plugin can't break the surrounding transaction flow.
 */
export async function checkBudgetThresholds(
  transactions: Transaction[],
  budgetCategories: BudgetCategory[],
): Promise<void> {
  // Gate on master + per-category Settings toggles. Either being off means
  // we don't compute or schedule anything — cheap early-out.
  const settings = useSettingsStore.getState();
  if (!settings.notifMasterEnabled) return;
  if (!settings.notifBudgetsEnabled) return;

  const yearMonth = currentYearMonth();

  for (const cat of budgetCategories) {
    if (!cat.monthlyLimit || cat.monthlyLimit <= 0) continue;
    const spent = spentThisMonth(transactions, cat.id, yearMonth);
    const pct = (spent / cat.monthlyLimit) * 100;
    const trackerKey = lastFiredKey(cat.id, yearMonth);

    // Below 80%? Wipe the tracker so a future re-cross can fire again.
    // Without this, a user who deletes a big expense to drop under 80%
    // and then re-spends would silently miss the alert.
    if (pct < THRESHOLDS[0]) {
      if (localStorage.getItem(trackerKey)) localStorage.removeItem(trackerKey);
      continue;
    }

    const highestCrossed: Threshold = pct >= THRESHOLDS[1] ? THRESHOLDS[1] : THRESHOLDS[0];
    const lastFiredRaw = localStorage.getItem(trackerKey);
    const lastFired = lastFiredRaw ? parseInt(lastFiredRaw, 10) : 0;
    if (lastFired >= highestCrossed) continue; // already alerted at this tier

    const title = highestCrossed === THRESHOLDS[1] ? 'Over budget' : 'Approaching budget';
    const body =
      `${cat.icon ? cat.icon + ' ' : ''}${cat.name}: ${formatAmount(spent)} / ${formatAmount(cat.monthlyLimit)}` +
      ` (${Math.round(pct)}%)`;

    try {
      const result = await scheduleNotification({
        id: await budgetNotifId(cat.id, highestCrossed),
        category: 'budgets',
        title,
        body,
        extra: { route: '/finance/budgets' },
        // "View category" action — opens the budgets page with the
        // category ID in the action extra so a downstream handler can
        // scroll to / highlight it. Default body tap goes to the same
        // route; the action gives users a one-tap path even when they
        // landed on the lockscreen from another context.
        actions: [
          { id: 'view', title: 'View category', route: '/finance/budgets', extra: { categoryId: cat.id } },
        ],
      });
      if (result.ok) {
        localStorage.setItem(trackerKey, String(highestCrossed));
      }
    } catch (e) {
      console.warn('[budgetAlerts]', cat.name, (e as Error).message);
    }
  }
}
