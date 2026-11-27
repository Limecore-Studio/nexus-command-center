import { manualHoldingValueBase } from './manualValuation';
import { convertSync } from '../api/fxRates';
import type { QuoteResult } from '../api/finnhub';
import type { CryptoResult } from '../api/coingecko';
import { isManuallyPriced, type PortfolioHolding, type PortfolioLot } from '../types/finance';

/** v1.22 (NCC#263): the portfolio's value in the base currency, and how many
 *  holdings could not be priced (no quote, no rate). Out of the store so it
 *  can be tested without one. */
export function computeTotalBase(
  holdings: PortfolioHolding[],
  stockQuotes: QuoteResult[],
  cryptoPrices: CryptoResult | null,
  rates: Record<string, number> | null,
  baseCurrency: string,
  lots: PortfolioLot[] = [],
): { total: number | null; unpriced: number } {
  let total = 0;
  let anyPriced = false;
  let unpriced = 0;
  for (const h of holdings) {
    // v1.19 (NCC#204): bonds and custom holdings carry their own price.
    if (isManuallyPriced(h.assetType)) {
      const v = manualHoldingValueBase(h, lots, rates, baseCurrency);
      if (v == null) {
        unpriced++;
        continue;
      }
      total += v;
      anyPriced = true;
      continue;
    }
    if (h.assetType === 'stock' || h.assetType === 'etf') {
      const q = stockQuotes.find((s) => s.ticker === h.ticker);
      if (!q) {
        unpriced++;
        continue;
      }
      const native = q.quote.c * h.quantity;
      const conv = convertSync(native, q.currency, baseCurrency, rates);
      if (conv == null) {
        unpriced++;
        continue;
      }
      total += conv;
      anyPriced = true;
    } else {
      const p = cryptoPrices?.prices.find((p) => p.id === h.ticker);
      if (!p) {
        unpriced++;
        continue;
      }
      const nativeEur = p.priceEur * h.quantity;
      const conv = baseCurrency === 'EUR' ? nativeEur : convertSync(nativeEur, 'EUR', baseCurrency, rates);
      if (conv == null) {
        unpriced++;
        continue;
      }
      total += conv;
      anyPriced = true;
    }
  }
  return { total: anyPriced ? total : null, unpriced };
}
