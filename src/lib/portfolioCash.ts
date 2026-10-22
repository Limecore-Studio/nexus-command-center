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

// v1.18.1 (NCC#149, NCC#164) — moving money between an account and the
// portfolio (Deposit, Withdraw, Savings "Invest") changes the account's
// OPENING balance, which is undated, while the cash entry is dated when it
// happened. Read as-is, any balance as of a date before a move is short by
// the move: the net-worth trend lost it for past months (#149) and the
// account statement for every row dated before it (#164). This is what to add
// back to such a balance: the moves for `accountId` that `isLater` picks, in
// `currency` (a deposit adds back what it took out; a withdrawal, stored
// negative, takes back off what it put in). An entry with no FX rate is
// skipped. Converted at today's rates, like every other past balance here.
export function laterPortfolioMoves(
  entries: PortfolioCashEntry[],
  accountId: string,
  currency: string,
  fxRates: Record<string, number> | null,
  isLater: (e: PortfolioCashEntry) => boolean,
): number {
  let sum = 0;
  for (const e of entries) {
    if (e.accountId !== accountId || (e.type !== 'deposit' && e.type !== 'withdrawal')) continue;
    if (!isLater(e)) continue;
    const v = e.currency === currency ? e.amount : convertSync(e.amount, e.currency, currency, fxRates);
    if (v != null) sum += v;
  }
  return sum;
}
