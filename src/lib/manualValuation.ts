// v1.19 — NCC#204: valuing holdings that have no quote feed.
//
//   custom — the price the user entered, times the units held.
//   bond   — hold to maturity. Each lot's BOOK price moves in a straight line
//            from what was paid to the face value on the maturity date; to
//            that comes the interest accrued since the last coupon
//            (actual/actual within the coupon period). A price the user
//            enters (manualPrice) replaces the book price until cleared; the
//            accrued interest is added either way, so a quoted (clean) price
//            and the book price are compared like for like.
//
// No external API: the free sources give yield curves, not the price of the
// bond the user holds (see NCC#204).
import { convertSync } from '../api/fxRates';
import type { BondTerms, PortfolioHolding, PortfolioLot, StockSale } from '../types/finance';
import { localDateKey, parseDateLocal } from '@/utils/formatters';

const DAY_MS = 86_400_000;
const days = (a: string, b: string) =>
  Math.round((parseDateLocal(b).getTime() - parseDateLocal(a).getTime()) / DAY_MS);

const daysInMonth = (y: number, m: number) => new Date(y, m + 1, 0).getDate();

/** The coupon date k periods before maturity (k = 0 is the maturity),
 *  keeping the maturity's day of month, clamped to short months. */
export function couponDateBefore(terms: Pick<BondTerms, 'maturity' | 'couponFrequency'>, k: number): string {
  const m = parseDateLocal(terms.maturity);
  const step = 12 / (terms.couponFrequency || 1);
  const total = m.getMonth() - k * step;
  const y = m.getFullYear() + Math.floor(total / 12);
  const mo = ((total % 12) + 12) % 12;
  return localDateKey(new Date(y, mo, Math.min(m.getDate(), daysInMonth(y, mo))));
}

/** The coupon period `date` falls in: [prev, next). Undefined for a
 *  zero-coupon bond or on/after maturity. */
export function couponPeriod(terms: BondTerms, date: string): { prev: string; next: string } | undefined {
  if (!terms.couponFrequency || date >= terms.maturity) return undefined;
  for (let k = 1; k < 2000; k++) {
    const prev = couponDateBefore(terms, k);
    if (prev <= date) return { prev, next: couponDateBefore(terms, k - 1) };
  }
  return undefined;
}

/** One coupon payment per unit, in the bond's currency. */
export const couponPerUnit = (t: BondTerms) =>
  t.couponFrequency ? (t.faceValue * t.couponRate) / 100 / t.couponFrequency : 0;

/** Interest accrued per unit on `date` since the last coupon. */
export function accruedPerUnit(terms: BondTerms, date: string): number {
  const p = couponPeriod(terms, date);
  if (!p) return 0;
  const span = days(p.prev, p.next);
  return span > 0 ? (couponPerUnit(terms) * days(p.prev, date)) / span : 0;
}

/** A lot's book price per unit on `date`: linear from its cost to face value
 *  at maturity. Its cost is converted into the bond's currency when the lot
 *  was entered in another one; null when that rate is missing. */
export function bookPricePerUnit(
  lot: Pick<PortfolioLot, 'costPerUnit' | 'costCurrency' | 'purchaseDate' | 'createdAt'>,
  terms: BondTerms,
  date: string,
  rates: Record<string, number> | null = null,
): number | null {
  const cost = lot.costCurrency === terms.currency
    ? lot.costPerUnit
    : convertSync(lot.costPerUnit, lot.costCurrency, terms.currency, rates);
  if (cost == null) return null;
  const start = lot.purchaseDate ?? (lot.createdAt ? lot.createdAt.slice(0, 10) : date);
  if (date >= terms.maturity) return terms.faceValue;
  const total = days(start, terms.maturity);
  if (total <= 0) return terms.faceValue;
  const frac = Math.min(1, Math.max(0, days(start, date) / total));
  return cost + (terms.faceValue - cost) * frac;
}

/** Units of a lot still held (sales come off its soldShares). */
const remaining = (l: PortfolioLot) => Math.max(0, l.quantity - (l.soldShares ?? 0));

export interface ManualValue {
  /** In `currency`. */
  value: number;
  currency: string;
  /** Which price the value rests on. */
  basis: 'book' | 'manual';
  /** Bonds: the accrued interest included in `value`. */
  accrued: number;
}

/**
 * A bond or custom holding's value in its own currency, or null when it has
 * no price to rest on (a custom holding without a price yet).
 */
export function manualHoldingValue(
  h: PortfolioHolding,
  lots: PortfolioLot[],
  date: string = localDateKey(new Date()),
  rates: Record<string, number> | null = null,
): ManualValue | null {
  if (h.assetType === 'custom') {
    if (h.manualPrice == null || !h.manualPriceCurrency) return null;
    return { value: h.manualPrice * h.quantity, currency: h.manualPriceCurrency, basis: 'manual', accrued: 0 };
  }
  if (h.assetType !== 'bond' || !h.bond) return null;
  const terms = h.bond;
  const own = lots.filter((l) => l.holdingId === h.id);
  const units = own.length ? own.reduce((s, l) => s + remaining(l), 0) : h.quantity;
  const accrued = accruedPerUnit(terms, date) * units;
  if (h.manualPrice != null && h.manualPriceCurrency) {
    const clean = h.manualPriceCurrency === terms.currency
      ? h.manualPrice
      : convertSync(h.manualPrice, h.manualPriceCurrency, terms.currency, rates);
    if (clean != null) return { value: clean * units + accrued, currency: terms.currency, basis: 'manual', accrued };
  }
  let book = 0;
  if (own.length) {
    for (const l of own) {
      const p = bookPricePerUnit(l, terms, date, rates);
      book += (p ?? terms.faceValue) * remaining(l);
    }
  } else {
    // No lots recorded: the holding's own quantity at face value.
    book = terms.faceValue * units;
  }
  return { value: book + accrued, currency: terms.currency, basis: 'book', accrued };
}

/** The same, in the base currency; null when unpriced or unconvertible. */
export function manualHoldingValueBase(
  h: PortfolioHolding,
  lots: PortfolioLot[],
  rates: Record<string, number> | null,
  baseCurrency: string,
  date?: string,
): number | null {
  const v = manualHoldingValue(h, lots, date, rates);
  if (!v) return null;
  return v.currency === baseCurrency ? v.value : convertSync(v.value, v.currency, baseCurrency, rates);
}

/** Units of a holding held at the START of `date` (lots bought before it,
 *  less shares sold before it): what a coupon on that date is paid on. */
export function unitsHeldOn(holdingId: string, lots: PortfolioLot[], sales: StockSale[], date: string): number {
  const bought = lots
    .filter((l) => l.holdingId === holdingId && (l.purchaseDate ?? l.createdAt.slice(0, 10)) < date)
    .reduce((s, l) => s + l.quantity, 0);
  const sold = sales.filter((s) => s.holdingId === holdingId && s.soldAt < date).reduce((s, x) => s + x.sharesSold, 0);
  return Math.max(0, bought - sold);
}

/** Days since a manual price was set ("updated N days ago"), or null. */
export function manualPriceAgeDays(h: Pick<PortfolioHolding, 'manualPriceAt'>, now = new Date()): number | null {
  if (!h.manualPriceAt) return null;
  const t = new Date(h.manualPriceAt).getTime();
  return Number.isFinite(t) ? Math.max(0, Math.floor((now.getTime() - t) / DAY_MS)) : null;
}
