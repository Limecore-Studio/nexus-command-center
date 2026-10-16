// v1.18.1 (NCC#164, NCC#176) — the rows and running-balance column of an
// account statement.
//
// AccountDetail walked the account's transactions oldest-first from
// `startingBalance`. Deposit, Withdraw and Savings "Invest" lower (or raise)
// that opening balance, which carries no date, so every row dated before such
// a move showed the balance short by its amount (#164). That was first fixed by
// adding the later moves back onto each row, but the moves themselves stayed
// invisible: when one came after the newest transaction, the top row did not
// equal the header balance (#176).
//
// Now each move for the account is a row of its own, dated on the local day
// its cash entry was made, and the walk starts from the opening balance as it
// was before any move (`startingBalance` minus every move row's delta). Each
// row is then the balance on its date, and the newest row is the current
// balance, move or not. A move is taken at the amount the account was actually
// debited (portfolioMoveIn), so a cross-currency move does not drift.
//
// Pure, so it can be tested without the store.

import { isPortfolioMove, portfolioMoveIn } from './portfolioCash';
import { localDayOf } from '../utils/formatters';
import type { PortfolioCashEntry } from '../types/finance';

export interface StatementRow {
  /** `YYYY-MM-DD`, the local date. */
  date: string;
  /** ISO timestamp; orders rows that share a date. */
  createdAt: string;
  /** Signed effect on the account, in the account's currency. */
  delta: number;
  /** A portfolio move: its delta is already inside `startingBalance`. */
  move?: PortfolioCashEntry;
}

/** The account's Deposit / Withdraw / Invest moves as statement rows. A
 *  deposit (+ to the portfolio) is a debit here, a withdrawal a credit. A move
 *  that cannot be converted (another currency, no stored amount, no FX rate
 *  yet) is left out, from the opening as well, so the balances stay
 *  consistent with the header; it is counted in `unconvertible` so the screen
 *  can say so in its "couldn't be FX-converted" notice. */
export function portfolioMoveRows(
  account: { id: string; currency: string },
  cashEntries: PortfolioCashEntry[],
  fxRates: Record<string, number> | null,
): { rows: StatementRow[]; unconvertible: number } {
  const rows: StatementRow[] = [];
  let unconvertible = 0;
  for (const e of cashEntries) {
    if (!isPortfolioMove(e, account.id)) continue;
    const v = portfolioMoveIn(e, account.currency, fxRates);
    if (v == null) {
      unconvertible++;
      continue;
    }
    rows.push({ date: localDayOf(e.createdAt), createdAt: e.createdAt, delta: -v, move: e });
  }
  return { rows, unconvertible };
}

/** Oldest-first by date, then createdAt — the order the walk needs. A move's
 *  date is the local day it was recorded, but a transaction's is the day the
 *  user picked, so a transaction backdated onto a move's day sorts after the
 *  move (its createdAt is later). Accepted: the balances after the day are
 *  right either way, only the order within that day is a guess. */
export function compareStatementRows(a: StatementRow, b: StatementRow): number {
  return a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt);
}

/** The balance before the first row: `startingBalance` with every move in
 *  `rows` undone. Equals `startingBalance` when there are no moves. */
export function statementOpening(startingBalance: number, rows: StatementRow[]): number {
  return rows.reduce((sum, r) => (r.move ? sum - r.delta : sum), startingBalance);
}

/** Running balance AFTER each row, for `rows` sorted with
 *  compareStatementRows. The last one is `startingBalance` plus the
 *  transaction deltas: the current balance. */
export function statementRunningBalances(startingBalance: number, rows: StatementRow[]): number[] {
  let running = statementOpening(startingBalance, rows);
  return rows.map((r) => (running += r.delta));
}
