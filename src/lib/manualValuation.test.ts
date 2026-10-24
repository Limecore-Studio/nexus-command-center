import { describe, it, expect, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';

// v1.19 — NCC#204: bond and custom holdings. Valuation (pure), the coupon
// rule a bond gets, and what the recurring engine writes on coupon dates and
// at maturity (real Dexie via fake-indexeddb).

vi.mock('./supabase', () => ({ supabase: {} }));

const {
  accruedPerUnit, bookPricePerUnit, couponDateBefore, couponPeriod, manualHoldingValue, manualHoldingValueBase, unitsHeldOn,
} = await import('./manualValuation');
const { holdingValueBase } = await import('./positionValue');
const { desiredCouponRule, couponRuleId } = await import('./bondCoupons');
const { materializeDue } = await import('./recurringMaterialize');
const { convertSync } = await import('../api/fxRates');
const { db } = await import('../db/database');
type Holding = import('../types/finance').PortfolioHolding;
type Lot = import('../types/finance').PortfolioLot;
type Terms = import('../types/finance').BondTerms;

const terms: Terms = { faceValue: 100, currency: 'EUR', couponRate: 4, couponFrequency: 1, maturity: '2030-06-15' };
const bond = (over: Partial<Holding> = {}): Holding => ({
  id: 'b1', ticker: 'DE-2030', name: 'Bund 2030', assetType: 'bond', quantity: 10, createdAt: '2026-01-01T00:00:00Z', bond: terms, ...over,
});
const lot = (over: Partial<Lot> = {}): Lot => ({
  id: 'l1', holdingId: 'b1', quantity: 10, costPerUnit: 90, costCurrency: 'EUR', purchaseDate: '2026-06-15',
  syncStatus: 'synced', createdAt: '2026-06-15T00:00:00Z', ...over,
});

describe('coupon schedule and accrual (actual/actual)', () => {
  it('walks back from maturity keeping its day, and clamps short months', () => {
    expect(couponDateBefore(terms, 0)).toBe('2030-06-15');
    expect(couponDateBefore(terms, 4)).toBe('2026-06-15');
    const eom = { maturity: '2027-08-31', couponFrequency: 4 as const };
    expect([1, 2, 3].map((k) => couponDateBefore(eom, k))).toEqual(['2027-05-31', '2027-02-28', '2026-11-30']);
  });

  it('is zero on a coupon date and grows through the period', () => {
    expect(accruedPerUnit(terms, '2026-06-15')).toBe(0);
    expect(couponPeriod(terms, '2026-12-15')).toEqual({ prev: '2026-06-15', next: '2027-06-15' });
    expect(accruedPerUnit(terms, '2026-12-15')).toBeCloseTo((4 * 183) / 365, 10);
    expect(accruedPerUnit(terms, '2027-06-14')).toBeCloseTo((4 * 364) / 365, 10);
    expect(accruedPerUnit(terms, '2027-06-15')).toBe(0);
  });

  it('semi-annual: half the coupon, over a half-year period', () => {
    const semi = { ...terms, couponFrequency: 2 as const };
    expect(couponPeriod(semi, '2027-01-15')).toEqual({ prev: '2026-12-15', next: '2027-06-15' });
    expect(accruedPerUnit(semi, '2027-01-15')).toBeCloseTo((2 * 31) / 182, 10);
  });

  it('no accrual for a zero-coupon bond or after maturity', () => {
    expect(accruedPerUnit({ ...terms, couponFrequency: 0, couponRate: 0 }, '2027-01-01')).toBe(0);
    expect(accruedPerUnit(terms, '2031-01-01')).toBe(0);
  });
});

describe('book value (hold to maturity)', () => {
  it('moves linearly from a discount up to face value', () => {
    expect(bookPricePerUnit(lot(), terms, '2026-06-15')).toBe(90);
    expect(bookPricePerUnit(lot(), terms, '2028-06-15')).toBeCloseTo(90 + 10 * (731 / 1461), 10); // half-way, by days
    expect(bookPricePerUnit(lot(), terms, '2030-06-15')).toBe(100);
    expect(bookPricePerUnit(lot(), terms, '2031-01-01')).toBe(100);
  });

  it('moves linearly from a premium down to face value', () => {
    const p = bookPricePerUnit(lot({ costPerUnit: 110 }), terms, '2028-06-15')!;
    expect(p).toBeLessThan(110);
    expect(p).toBeGreaterThan(100);
    expect(p).toBeCloseTo(110 - 10 * (731 / 1461), 10);
  });

  it('values the remaining units at book plus accrued interest', () => {
    const v = manualHoldingValue(bond(), [lot({ soldShares: 4 })], '2026-12-15')!;
    expect(v.basis).toBe('book');
    expect(v.value).toBeCloseTo(6 * (bookPricePerUnit(lot(), terms, '2026-12-15')! + accruedPerUnit(terms, '2026-12-15')), 10);
  });

  it('a price the user entered wins over book value, accrued interest still added', () => {
    const h = bond({ manualPrice: 97, manualPriceCurrency: 'EUR', manualPriceAt: '2026-12-01T00:00:00Z' });
    const v = manualHoldingValue(h, [lot()], '2026-12-15')!;
    expect(v.basis).toBe('manual');
    expect(v.value).toBeCloseTo(10 * (97 + accruedPerUnit(terms, '2026-12-15')), 10);
    // Cleared: back to book.
    expect(manualHoldingValue(bond(), [lot()], '2026-12-15')!.basis).toBe('book');
  });
});

describe('custom holdings and the base currency', () => {
  const rates = { USD: 1, EUR: 0.9 };
  it('a custom holding is its price times units; unpriced is null, not 0', () => {
    const c: Holding = { id: 'c1', ticker: 'WATCH', name: 'Watch', assetType: 'custom', quantity: 2, createdAt: '', manualPrice: 1500, manualPriceCurrency: 'EUR' };
    expect(manualHoldingValue(c, [])).toMatchObject({ value: 3000, currency: 'EUR', basis: 'manual' });
    expect(manualHoldingValue({ ...c, manualPrice: undefined }, [])).toBeNull();
  });

  it('bonds count in the base currency through the shared holding value (net worth, allocation)', () => {
    const native = manualHoldingValue(bond(), [lot()], undefined, rates)!.value;
    const usd = holdingValueBase(bond(), [], null, rates, 'USD', [lot()]);
    expect(usd).toBeCloseTo(convertSync(native, 'EUR', 'USD', rates)!, 6);
    expect(manualHoldingValueBase(bond(), [lot()], rates, 'EUR')).toBeCloseTo(native, 10);
  });
});

describe('coupons and redemption through the recurring engine', () => {
  beforeEach(async () => {
    await Promise.all(db.tables.map((t) => t.clear()));
  });

  const deps = (today: string) => ({
    today, baseCurrency: 'EUR', unitPrice: () => null, convert: () => null, depositLabel: 'x',
  });

  it('one coupon rule per bond, deterministic, starting at the first coupon after the first purchase', async () => {
    const r = (await desiredCouponRule(bond(), [lot({ purchaseDate: '2026-03-01' })]))!;
    expect(r).toMatchObject({ kind: 'coupon', every: 12, unit: 'month', anchorDay: 15, startDate: '2026-06-15', endDate: '2030-06-15' });
    expect(r.id).toBe(await couponRuleId('b1'));
    const zero = (await desiredCouponRule(bond({ bond: { ...terms, couponRate: 0, couponFrequency: 0 } }), [lot()]))!;
    expect([zero.startDate, zero.endDate]).toEqual(['2030-06-15', '2030-06-15']);
  });

  it('pays each coupon on the units held that day, then redeems at face value and closes the holding', async () => {
    await db.portfolioHoldings.put(bond());
    await db.portfolioLots.bulkPut([
      lot({ id: 'l1', quantity: 10, purchaseDate: '2026-03-01' }),
      lot({ id: 'l2', quantity: 5, costPerUnit: 95, purchaseDate: '2028-01-10' }),
    ]);
    const res = await materializeDue(deps('2031-01-01'));
    const cash = (await db.portfolioCashEntries.toArray()).sort((a, b) => a.id.localeCompare(b.id));
    const coupons = cash.filter((c) => c.type === 'dividend').map((c) => c.amount).sort((a, b) => a - b);
    // 2026, 2027 on 10 units (4 each → 40); 2028, 2029, 2030 on 15 (60).
    expect(coupons).toEqual([40, 40, 60, 60, 60]);
    const [sale] = await db.stockSales.toArray();
    expect(sale).toMatchObject({ holdingId: 'b1', sharesSold: 15, salePricePerShare: 100, soldAt: '2030-06-15', currency: 'EUR' });
    expect(sale.realizedGainLoss).toBeCloseTo(15 * 100 - (10 * 90 + 5 * 95), 10);
    expect(cash.find((c) => c.type === 'sell')).toMatchObject({ amount: 1500, relatedId: sale.id });
    expect(res.touchedHoldings).toEqual(['b1']);
    expect(unitsHeldOn('b1', await db.portfolioLots.toArray(), await db.stockSales.toArray(), '2030-06-16')).toBe(0);

    // A second run (or a second device) adds nothing.
    expect((await materializeDue(deps('2031-01-01'))).created).toBe(0);
  });

  it('before maturity: coupons only, no redemption', async () => {
    await db.portfolioHoldings.put(bond());
    await db.portfolioLots.put(lot({ purchaseDate: '2026-03-01' }));
    await materializeDue(deps('2027-07-01'));
    expect((await db.portfolioCashEntries.toArray()).map((c) => c.type)).toEqual(['dividend', 'dividend']);
    expect(await db.stockSales.count()).toBe(0);
  });
});
