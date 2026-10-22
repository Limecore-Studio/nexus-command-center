// ─── v1.3.2 — Portfolio cash balance ───────────────────────────────────────
//
// The portfolio cash balance is DERIVED from the append-only cash ledger:
// sum every entry's signed amount, converted to the base currency. Entries are
// already signed (deposits/sells positive, buys/withdrawals negative), so this
// is a plain sum. Entries in a currency we can't convert yet are skipped (the
// caller can flag "partial" by comparing counts if it cares).

import type { PortfolioCashEntry } from '../types/finance';
import { convertSync } from '../api/fxRates';

export function portfolioCashBalance(
  entries: PortfolioCashEntry[],
  baseCurrency: string,
  fxRates: Record<string, number> | null,
): number {
  let total = 0;
  for (const e of entries) {
    const conv =
      e.currency === baseCurrency
        ? e.amount
        : convertSync(e.amount, e.currency, baseCurrency, fxRates);
    if (conv != null) total += conv;
  }
  return total;
}

// v1.18.1 (NCC#176) — a deposit/withdrawal as it hit its account, in
// `currency`. The account was debited (or credited) at the rate on the day of
// the move, and the entry records that amount (accountAmount), so history
// replays it exactly instead of re-converting at today's rate, which made rows
// before a cross-currency move drift with the exchange rate. Entries without
// it (made before v1.18.1, or on another device — the field is local-only)
// fall back to today's rate. Same sign as `amount`; null when unconvertible.
export function portfolioMoveIn(
  e: PortfolioCashEntry,
  currency: string,
  fxRates: Record<string, number> | null,
): number | null {
  if (e.accountAmount != null && e.accountCurrency === currency) return e.accountAmount;
  return e.currency === currency ? e.amount : convertSync(e.amount, e.currency, currency, fxRates);
}

export const isPortfolioMove = (e: PortfolioCashEntry, accountId: string): boolean =>
  e.accountId === accountId && (e.type === 'deposit' || e.type === 'withdrawal');

// v1.18.1 (NCC#149, NCC#164) — moving money between an account and the
// portfolio (Deposit, Withdraw, Savings "Invest") changes the account's
// OPENING balance, which is undated, while the cash entry is dated when it
// happened. Read as-is, any balance as of a date before a move is short by
// the move: the net-worth trend lost it for past months (#149). This is what
// to add back to such a balance: the moves for `accountId` that `isLater`
// picks, in `currency` (a deposit adds back what it took out; a withdrawal,
// stored negative, takes back off what it put in). An entry with no FX rate
// is skipped. (The account statement shows the moves as rows instead, #176.)
export function laterPortfolioMoves(
  entries: PortfolioCashEntry[],
  accountId: string,
  currency: string,
  fxRates: Record<string, number> | null,
  isLater: (e: PortfolioCashEntry) => boolean,
): number {
  let sum = 0;
  for (const e of entries) {
    if (!isPortfolioMove(e, accountId) || !isLater(e)) continue;
    const v = portfolioMoveIn(e, currency, fxRates);
    if (v != null) sum += v;
  }
  return sum;
}
