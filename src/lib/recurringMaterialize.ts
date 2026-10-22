// v1.19 — NCC#202: materialising recurring rules into ordinary rows.
//
// Runs on app open and after each cloud pull (useRecurringStore.materialize).
// For every active rule, each occurrence after `lastMaterializedDate` up to
// today becomes rows written straight to Dexie and queued, as the store's own
// write paths do:
//   transaction   → one Transaction
//   cash_deposit  → a transfer out of the account (so the account's derived
//                   balance moves on every device and app version) plus a
//                   portfolio cash `deposit` WITHOUT an accountId: the
//                   transfer already is the account side, and an accountId
//                   would make the statement and net-worth history count the
//                   move a second time (portfolioCash.isPortfolioMove)
//   buy           → a PortfolioLot plus its `buy` cash entry (as addLot)
//
// Every generated id is uuidv5(rule:date:part), so two devices produce the
// same rows; a row already on this device is never written again, and the
// first push of a generated row ignores one already on the server
// (cloudSyncPush.upsertMaybeGenerated), so an edit or delete made there
// survives. Missed days are caught up, at most MAX_OCCURRENCES_PER_RUN at a
// time.
//
// A market-price buy with no price loaded WAITS: the rule stops at that
// occurrence (waitingSince) and continues on the next run, when prices may be
// in. It never guesses a price.
import { db, type SyncQueueItem } from '../db/database';
import { enqueue } from '../db/syncQueue';
import type { PortfolioCashEntry, PortfolioHolding, PortfolioLot, StockSale, Transaction } from '../types/finance';
import type { RecurringRule } from '../types/recurring';
import { occurrenceId, occurrencesBetween } from './recurring';
import { reconcileCouponRules } from './bondCoupons';
import { couponPerUnit, unitsHeldOn } from './manualValuation';
import { applySoldShares, computeSale, saleCostBasisInCurrency, totalRemainingShares } from './stockSaleFifo';

export interface MaterializeDeps {
  /** Today, local YYYY-MM-DD. */
  today: string;
  baseCurrency: string;
  /** The loaded price of one unit of a holding, or null. */
  unitPrice: (h: PortfolioHolding) => { price: number; currency: string } | null;
  /** Converts between currencies at the loaded rates, or null. */
  convert: (amount: number, from: string, to: string) => number | null;
  /** Description of a generated portfolio deposit with no note of its own. */
  depositLabel: string;
}

export interface MaterializeResult {
  /** Rows written (all parts of all occurrences). */
  created: number;
  /** Holdings whose lots changed, for the caller to re-derive. */
  touchedHoldings: string[];
}

const now = () => new Date().toISOString();

async function put<T extends { id: string }>(
  table: { get(id: string): Promise<T | undefined>; add(row: T): Promise<unknown> },
  entityType: SyncQueueItem['entityType'],
  row: T,
): Promise<boolean> {
  if (await table.get(row.id)) return false;
  await table.add(row);
  await enqueue(entityType, row.id, 'insert', row);
  return true;
}

/** Writes one occurrence. false = it must wait (no price, no holding). */
async function writeOccurrence(rule: RecurringRule, date: string, deps: MaterializeDeps, out: MaterializeResult): Promise<boolean> {
  const createdAt = now();
  if (rule.kind === 'transaction') {
    const t = rule.template;
    const tx: Transaction = {
      id: await occurrenceId(rule.id, date, 'tx'),
      type: t.type,
      amount: t.amount,
      description: t.description,
      categoryId: t.categoryId,
      accountId: t.accountId,
      destinationAccountId: t.type === 'transfer' ? t.destinationAccountId : undefined,
      date,
      recurringRuleId: rule.id,
      syncStatus: 'pending',
      createdAt,
    };
    if (await put(db.transactions, 'transaction', tx)) out.created++;
    return true;
  }

  if (rule.kind === 'cash_deposit') {
    const t = rule.template;
    const txId = await occurrenceId(rule.id, date, 'tx');
    const tx: Transaction = {
      id: txId,
      type: 'transfer',
      amount: t.amount,
      // A transfer with no destination is "out of this account"; the cloud
      // keeps it a transfer through its description marker, so it needs one.
      description: t.note?.trim() || deps.depositLabel,
      accountId: t.accountId,
      date,
      recurringRuleId: rule.id,
      syncStatus: 'pending',
      createdAt,
    };
    const cash: PortfolioCashEntry = {
      id: await occurrenceId(rule.id, date, 'cash'),
      type: 'deposit',
      amount: t.amount,
      currency: deps.baseCurrency,
      relatedId: txId,
      note: t.note,
      recurringRuleId: rule.id,
      createdAt,
      syncStatus: 'pending',
    };
    if (await put(db.transactions, 'transaction', tx)) out.created++;
    if (await put(db.portfolioCashEntries, 'portfolio_cash_entry', cash)) out.created++;
    return true;
  }

  if (rule.kind === 'coupon') return writeCoupon(rule, date, out);

  const t = rule.template;
  const holding = await db.portfolioHoldings.get(t.holdingId);
  if (!holding) return false;
  let price: number;
  let currency: string;
  if (t.priceMode === 'fixed') {
    if (!(t.price && t.price > 0)) return false;
    price = t.price;
    currency = t.currency;
  } else {
    const p = deps.unitPrice(holding);
    if (!p) return false;
    price = p.price;
    currency = p.currency;
  }
  let quantity: number;
  if (t.quantity && t.quantity > 0) {
    quantity = t.quantity;
  } else {
    if (!(t.amount && t.amount > 0)) return false;
    const amount = t.currency === currency ? t.amount : deps.convert(t.amount, t.currency, currency);
    if (amount == null) return false;
    quantity = amount / price;
  }
  const lot: PortfolioLot = {
    id: await occurrenceId(rule.id, date, 'lot'),
    holdingId: holding.id,
    quantity,
    costPerUnit: price,
    costCurrency: currency,
    purchaseDate: date,
    notes: t.note,
    recurringRuleId: rule.id,
    syncStatus: 'pending',
    createdAt,
  };
  const cash: PortfolioCashEntry = {
    id: await occurrenceId(rule.id, date, 'cash'),
    type: 'buy',
    amount: -(quantity * price),
    currency,
    relatedId: lot.id,
    recurringRuleId: rule.id,
    createdAt,
    syncStatus: 'pending',
  };
  if (await put(db.portfolioLots, 'portfolio_lot', lot)) {
    out.created++;
    if (!out.touchedHoldings.includes(holding.id)) out.touchedHoldings.push(holding.id);
  }
  if (await put(db.portfolioCashEntries, 'portfolio_cash_entry', cash)) out.created++;
  return true;
}

/**
 * v1.19 (NCC#204): a bond's coupon date. The coupon is paid on the units
 * held at the start of the day; on the maturity date (the rule's end date)
 * the bond is also redeemed: those units are sold at face value (FIFO, like
 * any sale), the proceeds go to portfolio cash and the holding closes.
 * Waits while the holding or its terms are not on this device.
 */
async function writeCoupon(rule: Extract<RecurringRule, { kind: 'coupon' }>, date: string, out: MaterializeResult): Promise<boolean> {
  const holding = await db.portfolioHoldings.get(rule.template.holdingId);
  const terms = holding?.bond;
  if (!holding || !terms) return false;
  const createdAt = now();
  const [lots, sales] = await Promise.all([
    db.portfolioLots.where('holdingId').equals(holding.id).toArray(),
    db.stockSales.filter((s) => s.holdingId === holding.id).toArray(),
  ]);
  const ownLots = lots.length > 0;
  const units = ownLots ? unitsHeldOn(holding.id, lots, sales, date) : holding.quantity;

  const coupon = couponPerUnit(terms) * units;
  if (coupon > 0 && date <= terms.maturity) {
    const cash: PortfolioCashEntry = {
      id: await occurrenceId(rule.id, date, 'cash'),
      type: 'dividend',
      amount: coupon,
      currency: terms.currency,
      relatedId: holding.id,
      note: holding.ticker,
      recurringRuleId: rule.id,
      createdAt,
      syncStatus: 'pending',
    };
    if (await put(db.portfolioCashEntries, 'portfolio_cash_entry', cash)) out.created++;
  }

  if (date === terms.maturity && units > 0 && ownLots) {
    const saleId = await occurrenceId(rule.id, date, 'sale');
    if (!(await db.stockSales.get(saleId))) {
      const held = applySoldShares(lots, sales);
      const { lotAllocations } = computeSale(holding.ticker, Math.min(units, totalRemainingShares(held)), held);
      const sharesSold = lotAllocations.reduce((s, a) => s + a.sharesTaken, 0);
      if (sharesSold > 0) {
        const cost = saleCostBasisInCurrency(held, lotAllocations, terms.currency, () => null);
        const sale: StockSale = {
          id: saleId,
          ticker: holding.ticker,
          holdingId: holding.id,
          sharesSold,
          salePricePerShare: terms.faceValue,
          costBasisPerShare: cost / sharesSold,
          realizedGainLoss: terms.faceValue * sharesSold - cost,
          currency: terms.currency,
          soldAt: date,
          lotAllocations,
          syncStatus: 'pending',
          createdAt,
        };
        await put(db.stockSales, 'stock_sale', sale);
        const proceeds: PortfolioCashEntry = {
          id: await occurrenceId(rule.id, date, 'redeem'),
          type: 'sell',
          amount: terms.faceValue * sharesSold,
          currency: terms.currency,
          relatedId: sale.id,
          recurringRuleId: rule.id,
          createdAt,
          syncStatus: 'pending',
        };
        await put(db.portfolioCashEntries, 'portfolio_cash_entry', proceeds);
        out.created += 2;
        if (!out.touchedHoldings.includes(holding.id)) out.touchedHoldings.push(holding.id);
      }
    }
  }
  return true;
}

/** Materialise every due occurrence of every active rule. */
export async function materializeDue(deps: MaterializeDeps): Promise<MaterializeResult> {
  const out: MaterializeResult = { created: 0, touchedHoldings: [] };
  // v1.19 (NCC#204): bonds' coupon rules follow their holdings' terms.
  await reconcileCouponRules();
  for (const rule of await db.recurringRules.toArray()) {
    if (rule.pausedAt) continue;
    let last = rule.lastMaterializedDate;
    let waitingSince: string | undefined;
    for (const date of occurrencesBetween(rule, last, deps.today)) {
      if (!(await writeOccurrence(rule, date, deps, out))) {
        waitingSince = date;
        break;
      }
      last = date;
    }
    if (last !== rule.lastMaterializedDate) {
      const next = { ...rule, lastMaterializedDate: last, waitingSince, syncStatus: 'pending' as const, updatedAt: now() };
      await db.recurringRules.put(next);
      await enqueue('recurring_rule', next.id, 'update', next);
    } else if (waitingSince !== rule.waitingSince) {
      // Local-only flag: no push.
      await db.recurringRules.update(rule.id, { waitingSince });
    }
  }
  return out;
}
