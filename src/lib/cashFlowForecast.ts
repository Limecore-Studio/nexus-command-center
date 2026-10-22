// Cash Flow Forecast — v1.4.
//
// Pure, store-free derivation. Detects recurring income/expense patterns from
// the last 90 days of transactions and projects them forward over a 30- or
// 60-day window. No new logging, no persistence — progress is always derived
// from the existing transaction set, so editing a transaction immediately
// re-shapes the forecast.
//
// NOTE on currency: transactions in `useFinanceStore` are already stored in
// the user's base currency (see the spend-heatmap path in FinanceOverview),
// so this module needs no FX conversion — amounts are summed directly. The
// base-currency code is carried through only for display labelling.

import type { Transaction } from '../types/finance';
import type { RecurringRule, RecurringUnit } from '../types/recurring';
import { localDateKey, parseDateLocal } from '@/utils/formatters';
import { occurrencesBetween } from './recurring';

const DAY_MS = 86_400_000;

interface RecurringItem {
  /** Stable grouping key (`<type>:<categoryId | desc:...>`). */
  key: string;
  /** Display label — category name (with icon) or the transaction description. */
  label: string;
  type: 'income' | 'expense';
  /** Median per-occurrence amount, base currency. */
  estimatedAmount: number;
  /** Detected cadence: 7 (weekly), 14 (biweekly), or 30 (monthly). */
  intervalDays: 7 | 14 | 30;
  /** ISO date of the next expected occurrence (last seen + intervalDays). */
  nextExpected: string;
  /** high = 3+ consistent occurrences, medium = exactly 2. */
  confidence: 'high' | 'medium';
  /** How many consistent occurrences were seen in the 90-day window. */
  occurrences: number;
  /** v1.19 (NCC#202): set when the item is an explicit recurring rule, not a
   *  detected pattern; its exact cadence. */
  rule?: { every: number; unit: RecurringUnit };
}

interface CashFlowProjection {
  projectedIncome: number;
  projectedExpenses: number;
  netCashFlow: number;
  /** Base currency code, for display. */
  currency: string;
  recurringItems: RecurringItem[];
  forecastDays: 30 | 60;
  generatedAt: string;
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Detect recurring patterns from the last 90 days of transactions.
 * Recurring = same group (expense category, or normalised description for
 * income / uncategorised), similar amount (within 20% of the group median),
 * appearing at a regular cadence (weekly ±3d, biweekly ±3d, or monthly ±7d).
 *
 * @param categoryNames id → display label (icon + name) for expense categories.
 * @param now           injectable clock for deterministic tests.
 */
export function detectRecurring(
  transactions: Transaction[],
  baseCurrency: string,
  categoryNames: Map<string, string>,
  now: number = Date.now(),
): RecurringItem[] {
  void baseCurrency; // carried for symmetry; amounts are already base currency
  const windowStart = now - 90 * DAY_MS;

  interface Group {
    type: 'income' | 'expense';
    label: string;
    points: Array<{ date: number; amount: number }>;
  }
  const groups = new Map<string, Group>();

  for (const t of transactions) {
    if (t.type === 'transfer') continue;
    // v1.19 (NCC#202): a rule's own rows are forecast from the rule
    // (projectCashFlow's `rules`); detecting them too counted them twice.
    if (t.recurringRuleId) continue;
    const dateMs = parseDateLocal(t.date).getTime();
    if (!isFinite(dateMs) || dateMs < windowStart || dateMs > now) continue;
    if (!(t.amount > 0)) continue;

    const desc = (t.description ?? '').trim();
    const groupId = t.categoryId
      ? `${t.type}:cat:${t.categoryId}`
      : `${t.type}:desc:${desc.toLowerCase()}`;
    const label = t.categoryId
      ? (categoryNames.get(t.categoryId) ?? desc) || 'Uncategorised'
      : desc || (t.type === 'income' ? 'Income' : 'Expense');

    const g = groups.get(groupId);
    if (g) g.points.push({ date: dateMs, amount: t.amount });
    else groups.set(groupId, { type: t.type, label, points: [{ date: dateMs, amount: t.amount }] });
  }

  const items: RecurringItem[] = [];
  for (const [key, g] of groups) {
    if (g.points.length < 2) continue;

    const medAmount = median(g.points.map((p) => p.amount));
    if (medAmount <= 0) continue;

    // Keep only occurrences within 20% of the median amount — a category used
    // for both a €5 coffee and a €500 flight isn't a single recurring item.
    const consistent = g.points
      .filter((p) => Math.abs(p.amount - medAmount) <= 0.2 * medAmount)
      .sort((a, b) => a.date - b.date);
    if (consistent.length < 2) continue;

    const intervals: number[] = [];
    for (let i = 1; i < consistent.length; i++) {
      intervals.push((consistent[i].date - consistent[i - 1].date) / DAY_MS);
    }
    const medInterval = median(intervals);

    let intervalDays: 7 | 14 | 30;
    if (Math.abs(medInterval - 7) <= 3) intervalDays = 7;
    else if (Math.abs(medInterval - 14) <= 3) intervalDays = 14;
    else if (Math.abs(medInterval - 30) <= 7) intervalDays = 30;
    else continue;

    const lastDate = consistent[consistent.length - 1].date;
    const nextExpected = lastDate + intervalDays * DAY_MS;

    items.push({
      key,
      label: g.label,
      type: g.type,
      estimatedAmount: median(consistent.map((p) => p.amount)),
      intervalDays,
      nextExpected: new Date(nextExpected).toISOString(),
      confidence: consistent.length >= 3 ? 'high' : 'medium',
      occurrences: consistent.length,
    });
  }

  // Largest items first — the forecast list leads with what moves the needle.
  return items.sort((a, b) => b.estimatedAmount - a.estimatedAmount);
}

/**
 * Project recurring items forward over the forecast window. Each item
 * contributes one occurrence per intervalDays from its first expected date
 * after `now`, up to and including `now + forecastDays`; an item more than
 * one interval overdue is treated as ended. Totals are in base currency.
 */
export function projectCashFlow(
  recurring: RecurringItem[],
  forecastDays: 30 | 60,
  baseCurrency: string,
  now: number = Date.now(),
  rules: RecurringRule[] = [],
): CashFlowProjection {
  const windowEnd = now + forecastDays * DAY_MS;
  let projectedIncome = 0;
  let projectedExpenses = 0;
  const active: RecurringItem[] = [];

  // v1.19 (NCC#202): explicit income/expense rules, by their exact dates.
  // Only occurrences not written yet: a written one is a real transaction
  // already. Transfers, portfolio deposits and buys are not income/expense.
  const d = new Date(now);
  const yesterday = localDateKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1));
  const endKey = localDateKey(new Date(windowEnd));
  for (const r of rules) {
    if (r.kind !== 'transaction' || r.pausedAt) continue;
    const type = r.template.type;
    if (type !== 'income' && type !== 'expense') continue;
    const after = r.lastMaterializedDate && r.lastMaterializedDate > yesterday ? r.lastMaterializedDate : yesterday;
    const dates = occurrencesBetween(r, after, endKey, 64);
    if (dates.length === 0) continue;
    const total = r.template.amount * dates.length;
    if (type === 'income') projectedIncome += total;
    else projectedExpenses += total;
    const approxDays = r.unit === 'month' ? 30 * r.every : r.unit === 'week' ? 7 * r.every : r.every;
    active.push({
      key: `rule:${r.id}`,
      label: r.template.description,
      type,
      estimatedAmount: r.template.amount,
      intervalDays: approxDays <= 10 ? 7 : approxDays <= 21 ? 14 : 30,
      nextExpected: dates[0],
      confidence: 'high',
      occurrences: dates.length,
      rule: { every: r.every, unit: r.unit },
    });
  }

  for (const r of recurring) {
    let occ = parseDateLocal(r.nextExpected).getTime();
    if (!isFinite(occ)) continue;
    // v1.18.1 (NCC#150): an item more than a whole interval overdue has most
    // likely ended (a cancelled subscription, a moved-out rent): it is no
    // longer projected or listed. One that is only late is projected from
    // its next occurrence AFTER now; projecting the missed one as well
    // counted rent paid on the 8th twice in a 30-day window seen on the 12th.
    if (occ < now - r.intervalDays * DAY_MS) continue;
    while (occ < now) occ += r.intervalDays * DAY_MS;
    // The list shows the date the projection actually counts from.
    active.push({ ...r, nextExpected: new Date(occ).toISOString() });
    let count = 0;
    // Cap the loop defensively — forecastDays/intervalDays is tiny, but never
    // trust derived dates to terminate a while-loop unguarded.
    while (occ <= windowEnd && count < 64) {
      count++;
      occ += r.intervalDays * DAY_MS;
    }
    const total = r.estimatedAmount * count;
    if (r.type === 'income') projectedIncome += total;
    else projectedExpenses += total;
  }

  return {
    projectedIncome,
    projectedExpenses,
    netCashFlow: projectedIncome - projectedExpenses,
    currency: baseCurrency,
    recurringItems: active,
    forecastDays,
    generatedAt: new Date(now).toISOString(),
  };
}
