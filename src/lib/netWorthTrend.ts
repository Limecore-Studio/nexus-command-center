// v1.9 Item 14b #5 — net worth, properly trended.
//
// The Account model has existed since v1.2 but never got a time-series view.
// It does not need one added to the schema: a balance is `startingBalance` plus
// the signed sum of every transaction touching the account, so a balance AS OF
// any past date is the same sum truncated at that date. Replaying is exact, not
// an estimate, and it needs no new table and no backfill.
//
// Reuses `computeAccountBalance` rather than reimplementing the sum. That
// helper already handles transfer direction, liability sign conventions and
// cross-currency conversion; a second copy of that arithmetic in a screen full
// of money is the FX-consolidation mistake all over again.
//
// THREE THINGS THIS DELIBERATELY REFUSES TO INVENT
//
// 1. An account contributes only from its own `createdAt` forward. A savings
//    account added in July held money in March in real life, but the app has no
//    record of that and `startingBalance` carries no date. Back-dating it would
//    fabricate history. The step this creates at onboarding is real
//    information, so each point names the accounts that first appear in it and
//    the chart marks them — an explained step beats a smoothed lie.
// 2. Holdings history comes from `portfolioSnapshots`, which only exist from
//    the day the user first refreshed with priced holdings. Months before that
//    report `holdingsBase: null` — unknown, not zero — and the caller says so.
//    Portfolio CASH is different: the ledger is dated and append-only, so it
//    replays exactly like accounts do.
// 3. FX is converted at TODAY's rates, because that is the only rate table the
//    app has. A past balance in another currency is therefore restated in
//    today's money rather than historically accurate. `usedFx` is set so the
//    caller can say that out loud instead of implying precision it lacks.

import { computeAccountBalance } from './accountBalance';
import { laterPortfolioMoves, portfolioCashBalance } from './portfolioCash';
import { convertSync } from '../api/fxRates';
import { localDayOf } from '../utils/formatters';
import type {
  Account,
  AccountType,
  PortfolioCashEntry,
  PortfolioSnapshot,
  Transaction,
} from '../types/finance';

export interface NetWorthAccountSlice {
  id: string;
  name: string;
  accountType: AccountType;
  /** Balance in base currency. Negative for liabilities, by convention. */
  base: number;
}

export interface NetWorthPoint {
  /** `YYYY-MM`, the bucket this point represents. */
  month: string;
  /** `YYYY-MM-DD` the balances were actually evaluated at — the month end,
   *  except for the current month, which evaluates at today. */
  asOf: string;
  accounts: NetWorthAccountSlice[];
  accountsBase: number;
  /** null when no portfolio snapshot exists at or before `asOf`. */
  holdingsBase: number | null;
  portfolioCashBase: number;
  total: number;
  /** Accounts appearing for the first time at this point, by name. An
   *  unexplained vertical step is the fastest way to lose trust in a chart. */
  addedAccounts: string[];
}

export interface NetWorthTrend {
  points: NetWorthPoint[];
  /** At least one point has no holdings snapshot behind it. */
  hasHoldingsGap: boolean;
  /** At least one figure crossed a currency boundary, so today's rates were
   *  applied to a past balance. */
  usedFx: boolean;
  isEmpty: boolean;
}

interface Options {
  accounts: Account[];
  transactions: Transaction[];
  snapshots: PortfolioSnapshot[];
  cashEntries: PortfolioCashEntry[];
  fxRates: Record<string, number> | null;
  baseCurrency: string;
  /** How many months back to attempt, inclusive of the current one. */
  months: number;
  /** `YYYY-MM-DD`. Passed in rather than read from the clock so this stays a
   *  pure function. */
  today: string;
}

function monthEndKey(year: number, month1: number): string {
  const lastDay = new Date(year, month1, 0).getDate();
  return `${year}-${String(month1).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
}

// v1.18.1 (NCC#176) — the local day, as the account statement and every
// transaction date use (#145). This was the UTC day, so outside UTC a move
// near midnight at a month's edge landed in a different month here.
const dayOf = localDayOf;

export function buildNetWorthTrend({
  accounts,
  transactions,
  snapshots,
  cashEntries,
  fxRates,
  baseCurrency,
  months,
  today,
}: Options): NetWorthTrend {
  const empty: NetWorthTrend = { points: [], hasHoldingsGap: false, usedFx: false, isEmpty: true };
  if (months < 1 || !/^\d{4}-\d{2}-\d{2}$/.test(today)) return empty;

  // Ascending order is what makes the single-pass pointer walk below correct;
  // every input arrives from Dexie in an order we should not assume.
  const tx = [...transactions].sort((a, b) => a.date.localeCompare(b.date));
  const snaps = [...snapshots].sort((a, b) => a.date.localeCompare(b.date));
  const cash = [...cashEntries].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  // v1.18.1 (NCC#176) — each local day parsed once, not per account per
  // month (120 months × 10 accounts × 1 000 entries would be ~1.2M parses).
  const cashDay = new Map(cash.map((e) => [e, dayOf(e.createdAt)]));
  const accountDay = new Map(accounts.map((a) => [a, { created: dayOf(a.createdAt), archived: a.archivedAt ? dayOf(a.archivedAt) : '' }]));

  // Earliest evidence of anything. Months before this would be a flat zero
  // line that says nothing except "the app did not exist yet".
  const firstSeen = [
    ...accounts.map((a) => accountDay.get(a)!.created),
    ...(tx.length > 0 ? [tx[0].date] : []),
  ]
    .filter(Boolean)
    .sort()[0];
  if (!firstSeen) return empty;

  const ty = Number(today.slice(0, 4));
  const tm = Number(today.slice(5, 7));
  const buckets: { y: number; m: number }[] = [];
  for (let back = months - 1; back >= 0; back--) {
    // Date normalises the month underflow, so `tm - 1 - back` crossing a year
    // boundary is handled without any wrapping arithmetic here.
    const d = new Date(ty, tm - 1 - back, 1);
    buckets.push({ y: d.getFullYear(), m: d.getMonth() + 1 });
  }
  const inRange = buckets.filter(({ y, m }) => monthEndKey(y, m) >= firstSeen);
  if (inRange.length === 0) return empty;

  // v1.18.1 (NCC#149): moving money between an account and the portfolio
  // (Deposit, Withdraw, Savings "Invest") changes the account's OPENING
  // balance, which is undated, while the cash entry is dated when it
  // happened. Read as-is, every month before a deposit lost the amount and
  // net worth showed a drop that never happened. So for a month before a
  // move, the move is added back to the account it came from (see
  // laterPortfolioMoves). v1.18.1 (NCC#176): added back in the ACCOUNT's
  // currency, as the amount the account was actually debited (stored on the
  // entry), and then converted with the rest of the balance — not the move
  // re-converted into base at today's rate.
  const laterMoves = (account: Account, asOf: string): number =>
    laterPortfolioMoves(cash, account.id, account.currency, fxRates, (e) => cashDay.get(e)! > asOf);

  let txIdx = 0;
  let snapIdx = 0;
  let cashIdx = 0;
  const seenAccounts = new Set<string>();
  let hasHoldingsGap = false;
  let usedFx = false;

  const points: NetWorthPoint[] = inRange.map(({ y, m }) => {
    const end = monthEndKey(y, m);
    const asOf = end > today ? today : end;

    while (txIdx < tx.length && tx[txIdx].date <= asOf) txIdx++;
    const txSlice = tx.slice(0, txIdx);

    const live = accounts.filter(
      (a) =>
        accountDay.get(a)!.created <= asOf &&
        // An account archived in June should stop contributing after June
        // rather than vanish from its own history.
        (!a.archivedAt || accountDay.get(a)!.archived > asOf),
    );

    const slices: NetWorthAccountSlice[] = [];
    let accountsBase = 0;
    const addedAccounts: string[] = [];
    for (const a of live) {
      if (!seenAccounts.has(a.id)) {
        seenAccounts.add(a.id);
        addedAccounts.push(a.name);
      }
      const native = computeAccountBalance(a, txSlice, fxRates, baseCurrency).balance + laterMoves(a, asOf);
      let base: number | null = native;
      if (a.currency !== baseCurrency) {
        usedFx = true;
        base = convertSync(native, a.currency, baseCurrency, fxRates);
      }
      // A balance we cannot convert is unknown, and adding 0 for it would
      // quietly understate net worth. Drop the slice instead.
      if (base == null) continue;
      accountsBase += base;
      slices.push({ id: a.id, name: a.name, accountType: a.accountType, base });
    }

    while (snapIdx < snaps.length && snaps[snapIdx].date <= asOf) snapIdx++;
    const snap = snapIdx > 0 ? snaps[snapIdx - 1] : null;
    let holdingsBase: number | null = null;
    if (snap) {
      if (snap.baseCurrency === baseCurrency) {
        holdingsBase = snap.valueBase;
      } else {
        // Snapshots stamp the base currency they were taken in, so a user who
        // later switched currencies does not get a step change made of nothing
        // but the switch.
        usedFx = true;
        holdingsBase = convertSync(snap.valueBase, snap.baseCurrency, baseCurrency, fxRates);
      }
    }
    if (holdingsBase == null) hasHoldingsGap = true;

    while (cashIdx < cash.length && cashDay.get(cash[cashIdx])! <= asOf) cashIdx++;
    const portfolioCashBase = portfolioCashBalance(cash.slice(0, cashIdx), baseCurrency, fxRates);

    return {
      month: `${y}-${String(m).padStart(2, '0')}`,
      asOf,
      accounts: slices.sort((a, b) => b.base - a.base),
      accountsBase,
      holdingsBase,
      portfolioCashBase,
      total: accountsBase + (holdingsBase ?? 0) + portfolioCashBase,
      addedAccounts,
    };
  });

  return { points, hasHoldingsGap, usedFx, isEmpty: points.length === 0 };
}
