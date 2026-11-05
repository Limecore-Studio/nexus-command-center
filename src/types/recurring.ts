// v1.19 — NCC#202: recurring rules. A rule generates ordinary rows
// (transactions, portfolio lots, portfolio cash entries) for every due
// occurrence; see lib/recurringMaterialize.ts.
import type { SyncStatus, TransactionType } from './finance';

export type RecurringKind = 'transaction' | 'cash_deposit' | 'buy' | 'coupon' | 'yield';
export type RecurringUnit = 'day' | 'week' | 'month';

/** One transaction per occurrence. Amount in the base currency, as every
 *  transaction is. */
export interface TransactionTemplate {
  type: TransactionType;
  amount: number;
  description: string;
  accountId?: string;
  destinationAccountId?: string;
  categoryId?: string;
}

/** Money moved from an account into portfolio cash, base currency. */
export interface CashDepositTemplate {
  accountId: string;
  amount: number;
  note?: string;
}

/** A purchase of a holding: a fixed quantity, or a fixed amount at the
 *  occurrence's price (fractional units). `market` uses the price loaded at
 *  materialisation time; with none loaded the occurrence waits. */
export interface BuyTemplate {
  holdingId: string;
  quantity?: number;
  amount?: number;
  priceMode: 'market' | 'fixed';
  /** priceMode 'fixed': price per unit in `currency`. */
  price?: number;
  /** The currency of `price` / `amount`, and of the lot's cost. */
  currency: string;
  note?: string;
}

interface RuleBase {
  id: string;
  every: number;
  unit: RecurringUnit;
  /** Monthly: the day of month (1-31), clamped to the month's last day. */
  anchorDay?: number;
  /** Local dates, YYYY-MM-DD. */
  startDate: string;
  endDate?: string;
  /** The last occurrence date this rule has generated rows for. */
  lastMaterializedDate?: string;
  pausedAt?: string;
  /** LOCAL-ONLY: the occurrence a market-price buy is waiting on a price
   *  for. Not pushed; recomputed on every materialisation. */
  waitingSince?: string;
  syncStatus: SyncStatus;
  createdAt: string;
  updatedAt?: string;
}

export type RecurringRule =
  | (RuleBase & { kind: 'transaction'; template: TransactionTemplate })
  | (RuleBase & { kind: 'cash_deposit'; template: CashDepositTemplate })
  | (RuleBase & { kind: 'buy'; template: BuyTemplate })
  | (RuleBase & { kind: 'coupon'; template: CouponTemplate })
  | (RuleBase & { kind: 'yield'; template: YieldTemplate });

/** v1.20 (NCC#203): staking rewards accrued from an APY. Every day the units
 *  held earn `(1 + apy)^(1/365) − 1` more, at cost 0, into one lot per
 *  calendar month (recurringMaterialize.ts writeYield). The rule runs daily.
 *
 *  No `amount` or `quantity`, on purpose: NCC 1.19 reads a kind it does not
 *  know as a buy, and without either it waits instead of buying. */
export interface YieldTemplate {
  holdingId: string;
  /** Annual percentage yield, e.g. 5 for 5 %. */
  apyPct: number;
  /** The holding's cost currency, for the cost-0 lots (and so 1.19's buy
   *  rendering of this rule has a currency to format). */
  currency: string;
}

/** v1.19 (NCC#204): a bond's coupons and, on the rule's end date (the
 *  maturity), its redemption at face value. Made and kept in step by
 *  lib/bondCoupons.ts, one per bond holding, with a deterministic id; the
 *  amounts are worked out from the bond's terms and lots on each date. */
export interface CouponTemplate {
  holdingId: string;
}
