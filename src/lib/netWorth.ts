// v1.22 (NCC#252) — net worth in the base currency, in one place.
//
//   net worth = portfolio holdings value + portfolio cash
//               + Σ(derived account balances, liabilities already negative)
//
// This is the Finance overview's figure (FinanceOverview.tsx), which matches
// the Net Worth screen. The net-worth goal, the Insights card and What-If each
// had their own copy that read an account's stored opening balance (`value`,
// which leaves out every transaction), subtracted liabilities that are already
// stored negative (adding the debt), and left out portfolio cash.
import { convertSync } from '../api/fxRates';
import type { ManualAsset, PortfolioCashEntry, PortfolioHolding, PortfolioLot, Transaction } from '../types/finance';
import { computeAccountBalance } from './accountBalance';
import { portfolioCashBalance } from './portfolioCash';
import { holdingValueBase } from './positionValue';

export interface NetWorthInputs {
  holdings: PortfolioHolding[];
  portfolioLots?: PortfolioLot[];
  // What the valuation reads; the stores' full quote types fit.
  stockQuotes: Array<{ ticker: string; quote: { c: number }; currency: string }>;
  cryptoPrices: { prices: Array<{ id: string; priceEur: number }> } | null;
  fxRates: Record<string, number> | null;
  baseCurrency: string;
  manualAssets: ManualAsset[];
  transactions: Transaction[];
  portfolioCashEntries?: PortfolioCashEntry[];
}

export interface NetWorthParts {
  /** Holdings priced and converted; a holding with no price or rate is left out. */
  portfolioBase: number;
  cashBase: number;
  /** Each account's derived balance in the base currency; one with no rate is left out. */
  accounts: { account: ManualAsset; base: number }[];
  total: number;
}

export function netWorthParts(d: NetWorthInputs): NetWorthParts {
  let portfolioBase = 0;
  for (const h of d.holdings) {
    const v = holdingValueBase(
      h,
      d.stockQuotes as Parameters<typeof holdingValueBase>[1],
      d.cryptoPrices as Parameters<typeof holdingValueBase>[2],
      d.fxRates,
      d.baseCurrency,
      d.portfolioLots ?? [],
    );
    if (v != null) portfolioBase += v;
  }
  const cashBase = portfolioCashBalance(d.portfolioCashEntries ?? [], d.baseCurrency, d.fxRates);
  const accounts: NetWorthParts['accounts'] = [];
  let accountsBase = 0;
  for (const a of d.manualAssets) {
    const native = computeAccountBalance(a, d.transactions, d.fxRates, d.baseCurrency).balance;
    const base = a.currency === d.baseCurrency ? native : convertSync(native, a.currency, d.baseCurrency, d.fxRates);
    if (base == null) continue;
    accounts.push({ account: a, base });
    accountsBase += base;
  }
  return { portfolioBase, cashBase, accounts, total: portfolioBase + cashBase + accountsBase };
}
