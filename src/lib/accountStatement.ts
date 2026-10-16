// v1.18.1 (NCC#164) — the running-balance column of an account statement.
//
// AccountDetail walked the account's transactions oldest-first from
// `startingBalance`. Deposit, Withdraw and Savings "Invest" lower (or raise)
// that opening balance, which carries no date, so every row dated before such
// a move showed the balance short by its amount: put 5 000 into the portfolio
// today and last March's rows all read 5 000 lower than they were. The move's
// portfolio cash entry is dated, so each row adds back the moves that happened
// after it — the same add-back the net-worth trend uses (#149). The newest
// row, and the current balance, are unchanged when no move came later.
//
// Pure, so it can be tested without the store.

import { laterPortfolioMoves } from './portfolioCash';
import { localDateKey } from '../utils/formatters';
import type { PortfolioCashEntry } from '../types/finance';

export interface StatementRow {
  /** `YYYY-MM-DD`, the transaction's local date. */
  date: string;
  /** ISO timestamp; orders rows that share a date. */
  createdAt: string;
  /** Signed effect on the account, in the account's currency. */
  delta: number;
}

/** Running balance AFTER each row, for `rows` sorted oldest-first by
 *  date then createdAt (the order AccountDetail sorts them in). */
export function statementRunningBalances(
  account: { id: string; currency: string; startingBalance: number },
  rows: StatementRow[],
  cashEntries: PortfolioCashEntry[],
  fxRates: Record<string, number> | null,
): number[] {
  // A transaction's date is a local calendar day, so a move is placed on the
  // local day it happened, and after a same-day row only if it was recorded
  // later — the same tie-break the rows themselves are sorted by.
  const moveDay = new Map<string, string>();
  for (const e of cashEntries) moveDay.set(e.id, localDateKey(new Date(e.createdAt)));
  const after = (e: PortfolioCashEntry, row: StatementRow): boolean => {
    const day = moveDay.get(e.id) ?? '';
    return day > row.date || (day === row.date && e.createdAt > row.createdAt);
  };

  let running = account.startingBalance;
  return rows.map((row) => {
    running += row.delta;
    return running + laterPortfolioMoves(cashEntries, account.id, account.currency, fxRates, (e) => after(e, row));
  });
}
