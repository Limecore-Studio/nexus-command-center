// v1.21 (NCC#230): changing the base currency converts the amounts that are
// stored in it, at today's rate, after the user confirms (Settings).
//
// What is in the base currency, with no currency of its own: every
// transaction's `amount`, every budget's `monthlyLimit`, and the amount of a
// recurring `transaction` or `cash_deposit` rule (it generates transactions /
// cash deposits in the base currency). Everything else (accounts, holdings,
// lots, portfolio cash, savings goals) carries its own currency and is left
// alone.
//
// A budget shared WITH this user belongs to its owner, who set its limit in
// their own base currency; it is not ours to rewrite, so it is skipped.
//
// Order matters for the push label (cloudSyncPush stamps `currency` with the
// base currency read at drain time, after it lists the pending queue): the
// caller writes the new base currency FIRST, then applies the plan. A drain
// that lists these queue rows therefore reads the new currency too.
import { db } from '../db/database';
import { enqueue } from '../db/syncQueue';
import { convertSync } from '../api/fxRates';
import type { BudgetCategory, Transaction } from '../types/finance';
import type { RecurringRule } from '../types/recurring';

export interface CurrencyRebasePlan {
  from: string;
  to: string;
  /** 1 `from` in `to`. */
  rate: number;
  transactions: Transaction[];
  budgets: BudgetCategory[];
  rules: RecurringRule[];
  /** Budgets shared with this user, left as their owner set them. */
  sharedSkipped: number;
}

/** Rounded to the cent, which is how every amount is entered. */
const round2 = (n: number) => Math.round(n * 100) / 100;

/** The rows to rewrite, already converted. Null when no rate is known for
 *  the pair (nothing must change then: a half-converted ledger is worse than
 *  an unconverted one). */
export function planCurrencyRebase(input: {
  from: string;
  to: string;
  rates: Record<string, number> | null;
  transactions: Transaction[];
  budgets: BudgetCategory[];
  rules: RecurringRule[];
  userId: string | null;
  now?: string;
}): CurrencyRebasePlan | null {
  const { from, to, rates, userId } = input;
  const rate = convertSync(1, from, to, rates);
  if (rate == null || !(rate > 0)) return null;
  const conv = (n: number) => round2(n * rate);
  const now = input.now ?? new Date().toISOString();

  const transactions = input.transactions.map(
    (t): Transaction => ({ ...t, amount: conv(t.amount), syncStatus: 'pending' }),
  );

  let sharedSkipped = 0;
  const budgets: BudgetCategory[] = [];
  for (const b of input.budgets) {
    if (b.ownerId && b.ownerId !== userId) {
      sharedSkipped++;
      continue;
    }
    budgets.push({ ...b, monthlyLimit: conv(b.monthlyLimit) });
  }

  const rules: RecurringRule[] = [];
  for (const r of input.rules) {
    if (r.kind === 'transaction' || r.kind === 'cash_deposit') {
      rules.push({
        ...r,
        template: { ...r.template, amount: conv(r.template.amount) },
        syncStatus: 'pending',
        updatedAt: now,
      } as RecurringRule);
    }
  }

  return { from, to, rate, transactions, budgets, rules, sharedSkipped };
}

/** How many rows a change would touch, so the caller can skip the dialog
 *  when there is nothing to convert. */
export function planSize(p: Pick<CurrencyRebasePlan, 'transactions' | 'budgets' | 'rules'>): number {
  return p.transactions.length + p.budgets.length + p.rules.length;
}

/** Writes the converted rows and queues each for push, in one Dexie
 *  transaction: either every amount converts or none does. The caller
 *  reloads the stores afterwards. */
export async function applyCurrencyRebase(plan: CurrencyRebasePlan): Promise<void> {
  await db.transaction(
    'rw',
    [db.transactions, db.budgetCategories, db.recurringRules, db.syncQueue],
    async () => {
      if (plan.transactions.length) await db.transactions.bulkPut(plan.transactions);
      if (plan.budgets.length) await db.budgetCategories.bulkPut(plan.budgets);
      if (plan.rules.length) await db.recurringRules.bulkPut(plan.rules);
      for (const t of plan.transactions) await enqueue('transaction', t.id, 'update', t);
      for (const b of plan.budgets) await enqueue('budget_category', b.id, 'update', b);
      for (const r of plan.rules) await enqueue('recurring_rule', r.id, 'update', r);
    },
  );
}
