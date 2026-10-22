// v1.9 Item 14b — the one place a holding turns into a base-currency number.
//
// This maths existed in two places: `metricsFor()` in screens/finance/
// Portfolio.tsx and an inline loop in components/InsightsCard.tsx. They were
// byte-identical, which is the good case — the bad case is the day one gets a
// fix and the other doesn't, and the portfolio total silently disagrees with
// the insight that reads from it. In a screen full of money that is a
// correctness bug, not a tidiness one.
//
// Consolidated ahead of 14b's cash-flow diagram (#2) and the trended net-worth
// and budget-vs-actual views (#5, #6), all of which need the same conversion.
// The build plan's own note applies: build the aggregation once, render it
// several ways.
//
// Behaviour is deliberately UNCHANGED from both former copies:
//   - stock/etf: quote price x quantity, normalised out of the quote's
//     currency (Finnhub reports some venues in minor units — GBp, ZAc — which
//     `normalizeCurrency` folds to major), then converted to base.
//   - crypto:   CoinGecko prices in EUR, so it is EUR -> base, and the EUR
//     case short-circuits rather than round-tripping through a rate of 1.
//   - a missing quote returns null, NOT 0. "No price yet" and "worth nothing"
//     are different facts and callers rely on telling them apart.

import { convertSync, normalizeCurrency } from '../api/fxRates';
import type { PortfolioHolding, PortfolioLot } from '../types/finance';
import { isManuallyPriced } from '../types/finance';
import { manualHoldingValueBase } from './manualValuation';
import type { QuoteResult } from '../api/finnhub';
import type { CryptoResult } from '../api/coingecko';

/** Current market value of a holding in the user's base currency.
 *  `null` when no price is available for it yet. */
export function holdingValueBase(
  h: PortfolioHolding,
  stockQuotes: QuoteResult[],
  cryptoPrices: CryptoResult | null,
  rates: Record<string, number> | null,
  baseCurrency: string,
  /** v1.19 (NCC#204): a bond's book value is per lot. */
  lots: PortfolioLot[] = [],
): number | null {
  // v1.19 (NCC#204): bonds and custom holdings, no quote feed.
  if (isManuallyPriced(h.assetType)) return manualHoldingValueBase(h, lots, rates, baseCurrency);
  if (h.assetType === 'stock' || h.assetType === 'etf') {
    const q = stockQuotes.find((s) => s.ticker === h.ticker);
    if (!q) return null;
    const native = normalizeCurrency(q.quote.c * h.quantity, q.currency);
    return convertSync(native.amount, native.currency, baseCurrency, rates);
  }
  const p = cryptoPrices?.prices.find((cp) => cp.id === h.ticker);
  if (!p) return null;
  const nativeEur = p.priceEur * h.quantity;
  return baseCurrency === 'EUR' ? nativeEur : convertSync(nativeEur, 'EUR', baseCurrency, rates);
}

/** v1.19 (NCC#202) — one unit of a holding at the loaded price, in the
 *  price's own (major) currency; null with no price loaded. A recurring
 *  market-price buy waits on null rather than guessing. */
export function holdingUnitPrice(
  h: PortfolioHolding,
  stockQuotes: QuoteResult[],
  cryptoPrices: CryptoResult | null,
): { price: number; currency: string } | null {
  // v1.19 (NCC#204): the price the user entered, if any.
  if (isManuallyPriced(h.assetType)) {
    return h.manualPrice != null && h.manualPriceCurrency ? { price: h.manualPrice, currency: h.manualPriceCurrency } : null;
  }
  if (h.assetType === 'stock' || h.assetType === 'etf') {
    const q = stockQuotes.find((s) => s.ticker === h.ticker);
    if (!q || !(q.quote.c > 0)) return null;
    const n = normalizeCurrency(q.quote.c, q.currency);
    return { price: n.amount, currency: n.currency };
  }
  const p = cryptoPrices?.prices.find((cp) => cp.id === h.ticker);
  return p && p.priceEur > 0 ? { price: p.priceEur, currency: 'EUR' } : null;
}
