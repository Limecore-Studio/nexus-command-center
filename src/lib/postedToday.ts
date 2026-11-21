// v1.22 (NCC#294) — which recurring transactions were posted today, and
// whether today's card was dismissed (components/PostedTodayCard).
import type { Transaction } from '../types/finance';
import { localDateKey } from '../utils/formatters';

const KEY = 'nexus.postedToday.dismissed';

/** Transactions a recurring rule wrote for today, in the order given. */
export function postedToday(transactions: Transaction[], today: string = localDateKey(new Date())): Transaction[] {
  if (postedTodayDismissed(today)) return [];
  return transactions.filter((t) => t.recurringRuleId && t.date === today);
}

export function postedTodayDismissed(today: string = localDateKey(new Date())): boolean {
  try {
    return localStorage.getItem(KEY) === today;
  } catch {
    return false;
  }
}

/** Gone for the rest of today; tomorrow's postings show again. */
export function dismissPostedToday(today: string = localDateKey(new Date())): void {
  try {
    localStorage.setItem(KEY, today);
  } catch {
    /* private mode: it shows again next launch */
  }
}
