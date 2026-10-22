import { create } from 'zustand';
import { db } from '../db/database';
import { Transaction, BudgetCategory, PortfolioHolding, PortfolioLot, PortfolioSnapshot, ManualAsset, WatchlistItem, StockSale, PortfolioCashEntry, PortfolioCashEntryType } from '../types/finance';
import { generateId } from '../utils/uuid';
import { localDateKey } from '../utils/formatters';
import { enqueue } from '../db/syncQueue';
import { computeSale, applySoldShares, saleCostBasisInCurrency } from '../lib/stockSaleFifo';
import { getQuotes, QuoteResult } from '../api/finnhub';
import { getCryptoPrices, CryptoResult } from '../api/coingecko';
import { ensureFxRates, convertSync } from '../api/fxRates';
import { clearProviderErrors, lastProviderErrors, getYahooSparkline, type ProviderError } from '../api/yahoo';
import { getCompanyProfiles, type CompanyProfile } from '../api/companyProfile';
import {
  getStockMetric,
  getRecommendations,
  getCompanyNews,
  getEarningsCalendar,
  getDividendsAll,
  type StockMetric,
  type Recommendation,
  type NewsItem,
  type EarningsEvent,
  type DividendEvent,
} from '../api/stockDetail';
import { getMarketNews } from '../api/marketNews';
import { computeDividendCredits, guestDividendKey } from '../lib/dividendRealize';
import { useSettingsStore } from './useSettingsStore';
import { useSessionStore } from './useSessionStore';
import { checkBudgetThresholds } from '../lib/budgetAlerts';
// v1.2 follow-up — CTO Account refactor. The BUG-6 budgetAssetBridge helper
// is no longer wired (and the file removed): in the Account model every
// transaction already carries `accountId`, and `computeAccountBalance`
// derives the balance from those transactions. Mutating the account's
// `startingBalance` from a transaction handler — what the bridge used to
// do — would now DOUBLE-COUNT, since the derived balance already includes
// the transaction's signed delta.
import { runPortfolioEodTick } from '../lib/portfolioEod';
import { runNewsAlertsTick } from '../lib/newsAlerts';
import { runWatchlistAlertsTick } from '../lib/watchlistAlerts';

interface FinanceStore {
  transactions: Transaction[];
  budgetCategories: BudgetCategory[];
  holdings: PortfolioHolding[];
  // All purchase lots across all holdings, indexed by lot.id. Aggregate
  // quantity + avg cost per holding is derived in selectors; we don't
  // store an intermediate map because consumers usually need either
  // "lots for one holding" (filter) or "totals" (reduce), both cheap.
  portfolioLots: PortfolioLot[];
  // v1.3.1 (BUG-23) — realized stock sales. Drives the Realized P&L card +
  // closed-positions section; each lot's soldShares is derived from these.
  stockSales: StockSale[];
  // v1.3.2 — portfolio cash ledger (append-only signed movements).
  portfolioCashEntries: PortfolioCashEntry[];
  stockQuotes: QuoteResult[];
  cryptoPrices: CryptoResult | null;
  fxRates: Record<string, number> | null; // USD-anchored rates
  // Company profile metadata keyed by uppercase ticker. Used for sector
  // allocation, logos, exchange info. Populated lazily on refresh and
  // cached in Dexie for 7 days.
  companyProfiles: Record<string, CompanyProfile>;
  // 7-day price series per ticker (stocks) or coin id (crypto). Stocks come
  // from Yahoo chart range=7d, crypto from CoinGecko sparkline_in_7d.
  // Used by the SparkLine component on each holding row.
  sparklines: Record<string, number[]>;
  // Daily snapshots of total portfolio value in base currency. Newest last.
  portfolioSnapshots: PortfolioSnapshot[];
  // Tier 2 — lazy per-ticker detail (fetched on detail sheet open).
  stockMetrics: Record<string, StockMetric>;
  recommendations: Record<string, Recommendation[]>;
  companyNews: Record<string, NewsItem[]>;
  // Tier 2 — eager (fetched alongside quotes on each portfolio refresh).
  upcomingEarnings: EarningsEvent[];
  dividends: Record<string, DividendEvent[]>;
  // Tier 3 — net worth manual assets/liabilities, watchlist, market news.
  manualAssets: ManualAsset[];
  watchlist: WatchlistItem[];
  marketNews: NewsItem[];
  // Per-ticker loading flags so the detail sheet can show a spinner instead
  // of a confused empty state on first open.
  detailLoading: Record<string, boolean>;
  loading: boolean;
  refreshing: boolean;
  // Per-provider failures from the most recent refresh attempt. Empty array
  // means everything succeeded (or there was nothing to refresh). Surface in
  // Portfolio.tsx so the user knows WHY data is stale instead of seeing a
  // generic "provider rate-limited" line.
  refreshErrors: ProviderError[];
  lastRefreshAt: number | null;

  load: () => Promise<void>;

  addTransaction: (
    t: Omit<Transaction, 'id' | 'createdAt' | 'syncStatus'>
  ) => Promise<void>;
  updateTransaction: (
    id: string,
    patch: Partial<Omit<Transaction, 'id' | 'createdAt'>>
  ) => Promise<void>;
  deleteTransaction: (id: string) => Promise<void>;
  /** v1.9 Item 14b #4 — CSV import. Returns the number written. */
  addTransactionsBulk: (
    rows: Omit<Transaction, 'id' | 'createdAt' | 'syncStatus'>[]
  ) => Promise<number>;

  addBudgetCategory: (c: Omit<BudgetCategory, 'id' | 'createdAt'>) => Promise<void>;
  updateBudgetCategory: (id: string, patch: Partial<BudgetCategory>) => Promise<void>;
  deleteBudgetCategory: (id: string) => Promise<void>;

  addHolding: (h: Omit<PortfolioHolding, 'id' | 'createdAt'>) => Promise<string>;
  updateHolding: (id: string, patch: Partial<PortfolioHolding>) => Promise<void>;
  deleteHolding: (id: string) => Promise<void>;

  addLot: (lot: Omit<PortfolioLot, 'id' | 'createdAt' | 'syncStatus'>) => Promise<void>;
  updateLot: (id: string, patch: Partial<Omit<PortfolioLot, 'id' | 'createdAt'>>) => Promise<void>;
  deleteLot: (id: string) => Promise<void>;

  // v1.3.1 (BUG-23) — record a FIFO stock sale. Computes cost basis over the
  // holding's current lots, persists the sale, re-derives soldShares, and
  // recomputes the holding's cached position. Throws on oversell.
  addStockSale: (input: {
    holdingId: string;
    ticker: string;
    sharesSold: number;
    salePricePerShare: number;
    currency: string;
    soldAt: string;
  }) => Promise<void>;
  deleteStockSale: (id: string) => Promise<void>;

  // v1.3.2 — portfolio cash transfers. `amount` is in `currency` (the UI passes
  // base currency). Deposit pulls from an account into portfolio cash;
  // withdrawal pushes portfolio cash back out to an account.
  depositToPortfolio: (input: { amount: number; currency: string; accountId: string; note?: string }) => Promise<void>;
  withdrawFromPortfolio: (input: { amount: number; currency: string; accountId: string; note?: string }) => Promise<void>;

  addManualAsset: (a: Omit<ManualAsset, 'id' | 'createdAt' | 'syncStatus'>) => Promise<void>;
  updateManualAsset: (id: string, patch: Partial<Omit<ManualAsset, 'id' | 'createdAt'>>) => Promise<void>;
  deleteManualAsset: (id: string) => Promise<void>;

  addWatchlistItem: (w: Omit<WatchlistItem, 'id' | 'createdAt' | 'syncStatus'>) => Promise<void>;
  updateWatchlistItem: (id: string, patch: Partial<Omit<WatchlistItem, 'id' | 'createdAt'>>) => Promise<void>;
  deleteWatchlistItem: (id: string) => Promise<void>;

  // `force: true` (default) — caller wants a fresh network round-trip; the
  // ↻ button in the UI uses this. `force: false` — auto-refresh paths
  // (cold-start in AppShell, resume-after-20min) should respect the cache
  // layer so back-to-back launches don't burn the Finnhub free-tier quota.
  refreshPortfolio: (opts?: { force?: boolean }) => Promise<void>;
  // Fetches metric + recommendations + news for one ticker. Idempotent and
  // cache-backed — cheap to call every time the detail sheet opens.
  fetchHoldingDetail: (ticker: string) => Promise<void>;
  // Eagerly populates `companyNews` for every owned stock/ETF. Called from
  // refreshPortfolio so the News screen has data without each row having
  // to be opened. Per-ticker cache (6h) absorbs repeat calls.
  loadCompanyNewsForHoldings: () => Promise<void>;
  // Loads benchmark quotes (SPY, IEUR, BTC). Merges into existing stockQuotes
  // and cryptoPrices state so the regular row pipeline can read them. Cached
  // and gated; safe to call on every mount of the MacroStrip.
  ensureBenchmarks: () => Promise<void>;
}

export const useFinanceStore = create<FinanceStore>((set, get) => ({
  transactions: [],
  budgetCategories: [],
  holdings: [],
  portfolioLots: [],
  stockSales: [],
  portfolioCashEntries: [],
  stockQuotes: [],
  cryptoPrices: null,
  fxRates: null,
  companyProfiles: {},
  sparklines: {},
  portfolioSnapshots: [],
  stockMetrics: {},
  recommendations: {},
  companyNews: {},
  upcomingEarnings: [],
  dividends: {},
  detailLoading: {},
  manualAssets: [],
  watchlist: [],
  marketNews: [],
  loading: false,
  refreshing: false,
  refreshErrors: [],
  lastRefreshAt: null,

  async load() {
    set({ loading: true });
    const [transactions, budgetCategories, holdings, portfolioLots, portfolioSnapshots, manualAssets, watchlist, stockSales] = await Promise.all([
      db.transactions.orderBy('date').reverse().toArray(),
      db.budgetCategories.toArray(),
      db.portfolioHoldings.toArray(),
      db.portfolioLots.toArray(),
      db.portfolioSnapshots.orderBy('date').toArray(),
      db.manualAssets.toArray(),
      db.watchlistItems.toArray(),
      db.stockSales.toArray(),
    ]);
    const portfolioCashEntries = await db.portfolioCashEntries.toArray();
    // Legacy migration: for any holding with avg_cost_native + quantity set
    // but no lots, synthesize one lot so the new lots-driven aggregation
    // keeps showing the same numbers. Runs once per device — we check the
    // local-only flag in localStorage so we don't re-create lots a user has
    // since deleted intentionally.
    const migrationKey = 'nexus.lotsMigrated.v1';
    if (!localStorage.getItem(migrationKey)) {
      const lotsByHolding = new Map<string, PortfolioLot[]>();
      for (const lot of portfolioLots) {
        const arr = lotsByHolding.get(lot.holdingId) ?? [];
        arr.push(lot);
        lotsByHolding.set(lot.holdingId, arr);
      }
      const synthesized: PortfolioLot[] = [];
      for (const h of holdings) {
        const existing = lotsByHolding.get(h.id) ?? [];
        if (existing.length === 0 && h.avgCostNative != null && h.costCurrency && h.quantity > 0) {
          const lot: PortfolioLot = {
            id: generateId(),
            holdingId: h.id,
            quantity: h.quantity,
            costPerUnit: h.avgCostNative,
            costCurrency: h.costCurrency,
            purchaseDate: h.createdAt?.slice(0, 10),
            syncStatus: 'pending',
            createdAt: new Date().toISOString(),
          };
          synthesized.push(lot);
          await db.portfolioLots.add(lot);
          await enqueue('portfolio_lot', lot.id, 'insert', lot);
        }
      }
      if (synthesized.length) portfolioLots.push(...synthesized);
      localStorage.setItem(migrationKey, '1');
    }
    // v1.3.1 (BUG-23) — soldShares is DERIVED from stock_sales.lotAllocations
    // (single source of truth), not a separately-synced lot field. Re-derive
    // on every load so a post-pull lot set (which arrives without soldShares —
    // the cloud portfolio_lots table doesn't carry it) is corrected.
    const lotsWithSold = applySoldShares(portfolioLots, stockSales);
    set({ transactions, budgetCategories, holdings, portfolioLots: lotsWithSold, portfolioSnapshots, manualAssets, watchlist, stockSales, portfolioCashEntries, loading: false });
  },

  async addTransaction(t) {
    const tx: Transaction = {
      ...t,
      id: generateId(),
      syncStatus: 'pending',
      createdAt: new Date().toISOString(),
    };
    await db.transactions.add(tx);
    await enqueue('transaction', tx.id, 'insert', tx);
    set({ transactions: [tx, ...get().transactions] });
    // v1.2 follow-up — CTO Account refactor. No bridge call: the Account
    // model derives balances from transactions, so adding a transaction
    // automatically updates every selector that reads
    // `computeAccountBalance(account, transactions, ...)`. Previously a
    // BUG-6 bridge mutated the account's startingBalance from this handler
    // — that would now double-count.
    // Budget alert hook — fire-and-forget. Recomputes spend% per category
    // and notifies on any newly-crossed 80%/100% threshold. The helper is
    // idempotent so re-running on every txn is fine.
    void checkBudgetThresholds(get().transactions, get().budgetCategories);
  },

  async updateTransaction(id, patch) {
    const existing = await db.transactions.get(id);
    if (!existing) return;
    const updated: Transaction = {
      ...existing,
      ...patch,
      id,
      syncStatus: 'pending',
    };
    await db.transactions.put(updated);
    await enqueue('transaction', id, 'update', updated);
    set({
      transactions: get().transactions.map((t) => (t.id === id ? updated : t)),
    });
    // v1.2 follow-up — CTO Account refactor. No bridge calls: balance is
    // derived from the transaction set, so changing accountId (or any
    // other field) is automatically reflected in every account's
    // computeAccountBalance the next time a selector reads it.
    void checkBudgetThresholds(get().transactions, get().budgetCategories);
  },

  async deleteTransaction(id) {
    await db.transactions.delete(id);
    await enqueue('transaction', id, 'delete', { id });
    set({ transactions: get().transactions.filter((t) => t.id !== id) });
    // v1.2 follow-up — CTO Account refactor. No bridge reverse: the deleted
    // transaction simply leaves the working set, and every account's
    // derived balance recomputes without its contribution.
    // Delete can drop spend below 80% → wipe the tracker so future re-cross
    // fires again. checkBudgetThresholds handles that bookkeeping itself.
    void checkBudgetThresholds(get().transactions, get().budgetCategories);
  },

  // v1.9 Item 14b #4 — CSV import writes hundreds of rows at once. Looping
  // addTransaction would be correct but pathological: one Dexie transaction,
  // one queue write, one store notification and one budget-threshold sweep per
  // row, so a 400-line bank export re-renders the app 400 times and runs the
  // O(n·m) alert scan 400 times. This does the same work once.
  //
  // Sync semantics are deliberately unchanged: every row still gets its own
  // `insert` queue entry, because the queue drains per-entity and a batched
  // payload would have no way to report a partial failure.
  async addTransactionsBulk(rows) {
    if (rows.length === 0) return 0;
    const now = new Date().toISOString();
    const txs: Transaction[] = rows.map((r) => ({
      ...r,
      id: generateId(),
      syncStatus: 'pending',
      createdAt: now,
    }));
    await db.transactions.bulkAdd(txs);
    for (const tx of txs) await enqueue('transaction', tx.id, 'insert', tx);
    // Imported rows are historical, so ordering by date keeps the transaction
    // list coherent rather than dumping a month of history on top of today.
    const merged = [...txs, ...get().transactions].sort((a, b) =>
      a.date === b.date ? b.createdAt.localeCompare(a.createdAt) : b.date.localeCompare(a.date),
    );
    set({ transactions: merged });
    void checkBudgetThresholds(merged, get().budgetCategories);
    return txs.length;
  },

  async addBudgetCategory(c) {
    const cat: BudgetCategory = {
      ...c,
      id: generateId(),
      createdAt: new Date().toISOString(),
    };
    await db.budgetCategories.add(cat);
    await enqueue('budget_category', cat.id, 'insert', cat);
    set({ budgetCategories: [...get().budgetCategories, cat] });
  },

  async updateBudgetCategory(id, patch) {
    const existing = await db.budgetCategories.get(id);
    if (!existing) return;
    const updated = { ...existing, ...patch, id };
    await db.budgetCategories.put(updated);
    await enqueue('budget_category', id, 'update', updated);
    set({
      budgetCategories: get().budgetCategories.map((c) => (c.id === id ? updated : c)),
    });
    // Lowering a monthlyLimit can push current spend over a threshold — re-check.
    void checkBudgetThresholds(get().transactions, get().budgetCategories);
  },

  async deleteBudgetCategory(id) {
    // Read the affected transactions before anything is destroyed. Until the
    // Dexie v23 index (issue #45) this lookup threw, and because the category
    // was already gone by then the delete was left half-applied: row deleted
    // and cloud delete queued, but the in-memory list and the orphaned
    // categoryIds never updated. Reading first means a failure here changes
    // nothing at all.
    const txs = await db.transactions.where('categoryId').equals(id).toArray();
    await db.budgetCategories.delete(id);
    await enqueue('budget_category', id, 'delete', { id });
    // Strip categoryId from any transactions referencing it.
    for (const t of txs) {
      await db.transactions.put({ ...t, categoryId: undefined, syncStatus: 'pending' });
      await enqueue('transaction', t.id, 'update', { ...t, categoryId: undefined });
    }
    set({
      budgetCategories: get().budgetCategories.filter((c) => c.id !== id),
      transactions: get().transactions.map((t) =>
        t.categoryId === id ? { ...t, categoryId: undefined } : t
      ),
    });
  },

  async addHolding(h) {
    const holding: PortfolioHolding = {
      ...h,
      id: generateId(),
      createdAt: new Date().toISOString(),
    };
    await db.portfolioHoldings.add(holding);
    await enqueue('portfolio_holding', holding.id, 'insert', holding);
    set({ holdings: [...get().holdings, holding] });
    return holding.id;
  },

  async updateHolding(id, patch) {
    const existing = await db.portfolioHoldings.get(id);
    if (!existing) return;
    const updated = { ...existing, ...patch, id };
    await db.portfolioHoldings.put(updated);
    await enqueue('portfolio_holding', id, 'update', updated);
    set({
      holdings: get().holdings.map((h) => (h.id === id ? updated : h)),
    });
  },

  async deleteHolding(id) {
    // Cascade lots locally; cloud cascades via FK ON DELETE CASCADE so we
    // just need to drain our local rows + sync queue entries.
    const lots = await db.portfolioLots.where('holdingId').equals(id).toArray();
    for (const lot of lots) {
      await db.portfolioLots.delete(lot.id);
      await enqueue('portfolio_lot', lot.id, 'delete', { id: lot.id });
    }
    await db.portfolioHoldings.delete(id);
    await enqueue('portfolio_holding', id, 'delete', { id });
    set({
      holdings: get().holdings.filter((h) => h.id !== id),
      portfolioLots: get().portfolioLots.filter((l) => l.holdingId !== id),
    });
  },

  async addLot(lot) {
    const row: PortfolioLot = {
      ...lot,
      id: generateId(),
      syncStatus: 'pending',
      createdAt: new Date().toISOString(),
    };
    await db.portfolioLots.add(row);
    await enqueue('portfolio_lot', row.id, 'insert', row);
    const nextLots = [...get().portfolioLots, row];
    set({ portfolioLots: nextLots });
    // v1.3.2 — a buy draws down portfolio cash by the lot's cost (can go
    // negative → the UI prompts to deposit to cover).
    await addCashEntry(set, get, {
      type: 'buy',
      amount: -(row.quantity * row.costPerUnit),
      currency: row.costCurrency,
      relatedId: row.id,
    });
    await recomputeHoldingAggregates(row.holdingId, nextLots, set, get);
  },

  async updateLot(id, patch) {
    const existing = await db.portfolioLots.get(id);
    if (!existing) return;
    const updated: PortfolioLot = {
      ...existing,
      ...patch,
      id,
      syncStatus: 'pending',
      updatedAt: new Date().toISOString(),
    };
    await db.portfolioLots.put(updated);
    await enqueue('portfolio_lot', id, 'update', updated);
    const nextLots = get().portfolioLots.map((l) => (l.id === id ? updated : l));
    set({ portfolioLots: nextLots });
    // v1.3.2 — keep the buy cash entry in lockstep with the edited lot cost.
    // Only touches lots that already produced a buy entry (post-feature buys),
    // so legacy/synthesized lots without an entry stay at zero cash impact.
    if (get().portfolioCashEntries.some((e) => e.relatedId === id && e.type === 'buy')) {
      await removeCashEntriesFor(set, get, id);
      await addCashEntry(set, get, {
        type: 'buy',
        amount: -(updated.quantity * updated.costPerUnit),
        currency: updated.costCurrency,
        relatedId: id,
      });
    }
    await recomputeHoldingAggregates(updated.holdingId, nextLots, set, get);
  },

  async deleteLot(id) {
    const existing = await db.portfolioLots.get(id);
    if (!existing) return;
    await db.portfolioLots.delete(id);
    await enqueue('portfolio_lot', id, 'delete', { id });
    const nextLots = get().portfolioLots.filter((l) => l.id !== id);
    set({ portfolioLots: nextLots });
    // v1.3.2 — deleting the lot reverses its cash draw-down.
    await removeCashEntriesFor(set, get, id);
    await recomputeHoldingAggregates(existing.holdingId, nextLots, set, get);
  },

  async addStockSale({ holdingId, ticker, sharesSold, salePricePerShare, currency, soldAt }) {
    const holdingLots = get().portfolioLots.filter((l) => l.holdingId === holdingId);
    // Throws on oversell — the form validates first; this is the backstop.
    const { lotAllocations } = computeSale(ticker, sharesSold, holdingLots);
    // Cost basis in the SALE currency (converts any lot bought in a different
    // currency first) so realized P/L isn't a cross-currency subtraction. For
    // a single-currency holding this is identical to the naive sum.
    const fxRates = get().fxRates;
    const costTotal = saleCostBasisInCurrency(
      holdingLots,
      lotAllocations,
      currency,
      (amt, from, to) => convertSync(amt, from, to, fxRates),
    );
    const costBasisPerShare = sharesSold > 0 ? costTotal / sharesSold : 0;
    const realizedGainLoss = salePricePerShare * sharesSold - costTotal;
    const sale: StockSale = {
      id: generateId(),
      ticker,
      holdingId,
      sharesSold,
      salePricePerShare,
      costBasisPerShare,
      realizedGainLoss,
      currency,
      soldAt,
      lotAllocations,
      syncStatus: 'pending',
      createdAt: new Date().toISOString(),
    };
    await db.stockSales.add(sale);
    await enqueue('stock_sale', sale.id, 'insert', sale);
    const nextSales = [...get().stockSales, sale];
    // Re-derive soldShares across all lots from the full sales set, then
    // persist the touched lots so the Dexie cache matches in-memory state.
    const nextLots = applySoldShares(get().portfolioLots, nextSales);
    for (const a of lotAllocations) {
      const l = nextLots.find((x) => x.id === a.lotId);
      if (l) await db.portfolioLots.put(l);
    }
    set({ stockSales: nextSales, portfolioLots: nextLots });
    // v1.3.2 — sale proceeds top up portfolio cash.
    await addCashEntry(set, get, {
      type: 'sell',
      amount: salePricePerShare * sharesSold,
      currency,
      relatedId: sale.id,
    });
    await recomputeHoldingAggregates(holdingId, nextLots, set, get);
  },

  async deleteStockSale(id) {
    const existing = get().stockSales.find((s) => s.id === id);
    if (!existing) return;
    await db.stockSales.delete(id);
    await enqueue('stock_sale', id, 'delete', { id });
    const nextSales = get().stockSales.filter((s) => s.id !== id);
    // Removing a sale returns its shares to the position — re-derive soldShares
    // and re-persist the lots it had touched.
    const nextLots = applySoldShares(get().portfolioLots, nextSales);
    for (const a of existing.lotAllocations ?? []) {
      const l = nextLots.find((x) => x.id === a.lotId);
      if (l) await db.portfolioLots.put(l);
    }
    set({ stockSales: nextSales, portfolioLots: nextLots });
    // v1.3.2 — removing the sale reverses its cash top-up.
    await removeCashEntriesFor(set, get, id);
    if (existing.holdingId) {
      await recomputeHoldingAggregates(existing.holdingId, nextLots, set, get);
    }
  },

  async depositToPortfolio({ amount, currency, accountId, note }) {
    if (!(amount > 0)) return;
    const account = get().manualAssets.find((a) => a.id === accountId);
    if (!account) throw new Error('Account not found.');
    // Convert the (base-currency) amount into the account's currency to debit it.
    const amtInAccount = account.currency === currency
      ? amount
      : convertSync(amount, currency, account.currency, get().fxRates);
    if (amtInAccount == null) {
      throw new Error(`Couldn't convert ${currency} → ${account.currency} (FX rate missing).`);
    }
    // Debit the source account by shifting its opening balance (mirrors the
    // Savings "Invest" sheet — keeps the derived balance consistent).
    const base = account.startingBalance ?? account.value ?? 0;
    const newOpening = base - amtInAccount;
    await get().updateManualAsset(accountId, { startingBalance: newOpening, value: newOpening });
    // Credit portfolio cash (+) — stored in the amount's currency.
    // v1.18.1 (NCC#176) — also record what the account was debited, so the
    // history views add back that, not a re-conversion at a later rate.
    await addCashEntry(set, get, {
      type: 'deposit', amount, currency, accountId, note,
      accountAmount: amtInAccount, accountCurrency: account.currency,
    });
  },

  async withdrawFromPortfolio({ amount, currency, accountId, note }) {
    if (!(amount > 0)) return;
    const account = get().manualAssets.find((a) => a.id === accountId);
    if (!account) throw new Error('Account not found.');
    const amtInAccount = account.currency === currency
      ? amount
      : convertSync(amount, currency, account.currency, get().fxRates);
    if (amtInAccount == null) {
      throw new Error(`Couldn't convert ${currency} → ${account.currency} (FX rate missing).`);
    }
    // Credit the destination account.
    const base = account.startingBalance ?? account.value ?? 0;
    const newOpening = base + amtInAccount;
    await get().updateManualAsset(accountId, { startingBalance: newOpening, value: newOpening });
    // Debit portfolio cash (−).
    // v1.18.1 (NCC#176) — record what the account was credited (see deposit).
    await addCashEntry(set, get, {
      type: 'withdrawal', amount: -amount, currency, accountId, note,
      accountAmount: -amtInAccount, accountCurrency: account.currency,
    });
  },

  async addManualAsset(a) {
    // v1.2 follow-up — CTO Account refactor. Mirror new-name ↔ old-name on
    // write so the on-disk row always carries BOTH `accountType`+`assetType`
    // and `startingBalance`+`value`. Callers can pass either pair; we
    // normalize to the canonical fields and back-fill the legacy ones.
    const accountType = a.accountType ?? a.assetType ?? 'other';
    const startingBalance =
      a.startingBalance ?? (typeof a.value === 'number' ? a.value : 0);
    const row: ManualAsset = {
      ...a,
      id: generateId(),
      accountType,
      startingBalance,
      // Legacy mirrors (kept in sync for back-compat with code that still
      // reads `asset.value` / `asset.assetType`).
      assetType: accountType,
      value: startingBalance,
      syncStatus: 'pending',
      createdAt: new Date().toISOString(),
    };
    await db.manualAssets.add(row);
    await enqueue('manual_asset', row.id, 'insert', row);
    set({ manualAssets: [...get().manualAssets, row] });
  },

  async updateManualAsset(id, patch) {
    const existing = await db.manualAssets.get(id);
    if (!existing) return;
    // v1.2 follow-up — CTO Account refactor. Same dual-field normalization
    // as `addManualAsset`. A patch that touches `accountType` or `value`
    // updates both sides of the mirror so the on-disk shape stays coherent.
    const merged: ManualAsset = {
      ...existing,
      ...patch,
      id,
      syncStatus: 'pending',
      updatedAt: new Date().toISOString(),
    };
    if (patch.accountType !== undefined) merged.assetType = patch.accountType;
    if (patch.assetType !== undefined) merged.accountType = patch.assetType;
    if (patch.startingBalance !== undefined) merged.value = patch.startingBalance;
    if (patch.value !== undefined) merged.startingBalance = patch.value;
    await db.manualAssets.put(merged);
    await enqueue('manual_asset', id, 'update', merged);
    set({ manualAssets: get().manualAssets.map((a) => (a.id === id ? merged : a)) });
  },

  async deleteManualAsset(id) {
    await db.manualAssets.delete(id);
    await enqueue('manual_asset', id, 'delete', { id });
    set({ manualAssets: get().manualAssets.filter((a) => a.id !== id) });
  },

  async addWatchlistItem(w) {
    const row: WatchlistItem = {
      ...w,
      ticker: w.assetType === 'crypto' ? w.ticker.toLowerCase() : w.ticker.toUpperCase(),
      id: generateId(),
      syncStatus: 'pending',
      createdAt: new Date().toISOString(),
    };
    await db.watchlistItems.add(row);
    await enqueue('watchlist_item', row.id, 'insert', row);
    set({ watchlist: [...get().watchlist, row] });
  },

  async updateWatchlistItem(id, patch) {
    const existing = await db.watchlistItems.get(id);
    if (!existing) return;
    const updated: WatchlistItem = {
      ...existing,
      ...patch,
      id,
      syncStatus: 'pending',
      updatedAt: new Date().toISOString(),
    };
    await db.watchlistItems.put(updated);
    await enqueue('watchlist_item', id, 'update', updated);
    set({ watchlist: get().watchlist.map((w) => (w.id === id ? updated : w)) });
  },

  async deleteWatchlistItem(id) {
    await db.watchlistItems.delete(id);
    await enqueue('watchlist_item', id, 'delete', { id });
    set({ watchlist: get().watchlist.filter((w) => w.id !== id) });
  },

  async refreshPortfolio(opts = {}) {
    // Default to force=true so the manual ↻ button and other call sites keep
    // their old "always hit the wire" behavior. Auto-refresh paths (cold start
    // + resume) opt OUT by passing force:false so the cache layer absorbs
    // back-to-back app launches.
    const force = opts.force !== false;
    const { holdings } = get();
    if (!holdings.length && !get().watchlist.length) {
      // Even with nothing to refresh, leave benchmark quotes alone so the
      // MacroStrip on the Portfolio screen keeps rendering.
      set({ refreshErrors: [], lastRefreshAt: Date.now() });
      return;
    }
    set({ refreshing: true, refreshErrors: [] });
    // Clear the global error bucket so we only capture this refresh's failures.
    // `force` controls whether a previously-cached "fresh" entry short-circuits
    // the network attempt — user-initiated refreshes want the wire, auto
    // refreshes are happy with cached data inside the soft-TTL.
    clearProviderErrors();
    // Belt-and-suspenders top-level guard: if any of the Promise.all calls
    // below reject unexpectedly (e.g. a transient network error in a fetcher
    // that wasn't supposed to throw), we'd otherwise leave refreshing=true
    // forever AND show no error to the user. The catch surfaces the error
    // and the finally always lifts the spinner.
    try {
    // ETFs use the same quote pipeline as stocks (Finnhub free + Yahoo
    // fallback). Treating them as a separate bucket here was the bug that
    // made every ETF row vanish after being tagged: no fetch → null
    // valueBase → invisible in totals, allocation, and the row list.
    // We also fetch watchlist quotes here so the Watchlist screen shows live
    // prices without each row having to fan out its own request.
    const watchlist = get().watchlist;
    const equityTickers = Array.from(
      new Set([
        ...holdings
          .filter((h) => h.assetType === 'stock' || h.assetType === 'etf')
          .map((h) => h.ticker),
        ...watchlist
          .filter((w) => w.assetType === 'stock' || w.assetType === 'etf')
          .map((w) => w.ticker),
      ]),
    );
    const cryptos = Array.from(
      new Set([
        ...holdings.filter((h) => h.assetType === 'crypto').map((h) => h.ticker),
        ...watchlist.filter((w) => w.assetType === 'crypto').map((w) => w.ticker),
      ]),
    );

    // Phase 1: quotes + FX + (in parallel) profiles + stock sparklines.
    // Profiles/sparklines use independent cache logic; we don't force them
    // here so the user clicking ↻ doesn't pay 2N extra requests every time —
    // only quotes get force:true.
    const [stockQuotes, cryptoPrices, fxPayload, profileMap, ...stockSparkLists] = await Promise.all([
      equityTickers.length ? getQuotes(equityTickers, { force }) : Promise.resolve([]),
      cryptos.length ? getCryptoPrices(cryptos, { force }) : Promise.resolve(null),
      ensureFxRates(),
      equityTickers.length ? getCompanyProfiles(equityTickers) : Promise.resolve(new Map<string, CompanyProfile>()),
      ...equityTickers.map((t) => getYahooSparkline(t)),
    ]);

    // Preserve any in-state quotes for tickers we DIDN'T ask for this round —
    // these are benchmark entries (SPY/IEUR/BTC) seeded by ensureBenchmarks().
    // Without this merge, every refresh would wipe out the MacroStrip's data
    // (the strip would flicker in then disappear as the refresh resolved).
    const requestedEquitySet = new Set(equityTickers.map((t) => t.toUpperCase()));
    const preservedEquityQuotes = get().stockQuotes.filter(
      (q) => !requestedEquitySet.has(q.ticker.toUpperCase()),
    );
    const mergedStockQuotes = [...stockQuotes, ...preservedEquityQuotes];

    const requestedCryptoSet = new Set(cryptos);
    const preservedCryptoPrices = get().cryptoPrices?.prices.filter(
      (p) => !requestedCryptoSet.has(p.id),
    ) ?? [];
    const mergedCryptoPrices: CryptoResult | null = cryptoPrices
      ? { ...cryptoPrices, prices: [...cryptoPrices.prices, ...preservedCryptoPrices] }
      : preservedCryptoPrices.length > 0 && get().cryptoPrices
        ? { ...get().cryptoPrices!, prices: preservedCryptoPrices }
        : null;

    // Merge profiles into the existing map (don't drop old ones we still
    // have cached but didn't fetch this round).
    const nextProfiles = { ...get().companyProfiles };
    for (const [k, v] of profileMap) nextProfiles[k] = v;

    // Sparkline map: equities from yahoo, crypto from coingecko's sparkline_in_7d.
    const nextSparklines: Record<string, number[]> = { ...get().sparklines };
    equityTickers.forEach((t, i) => {
      const series = stockSparkLists[i] as number[] | null;
      if (series && series.length) nextSparklines[t.toUpperCase()] = series;
    });
    if (cryptoPrices) {
      for (const p of cryptoPrices.prices) {
        if (p.spark7d && p.spark7d.length) nextSparklines[p.id.toLowerCase()] = p.spark7d;
      }
    }

    // Phase 2: write today's snapshot if we have enough data to compute a
    // meaningful total. "Meaningful" = at least one holding priced AND FX
    // rates resolved. We use local date so a same-day refresh upserts. We
    // pass the fresh (non-merged) quotes here since we only want USER holdings
    // counted in the snapshot, not benchmarks.
    const baseCurrency = useSettingsStore.getState().baseCurrency;
    const rates = fxPayload?.rates ?? get().fxRates;
    const totalBase = computeTotalBase(holdings, stockQuotes, cryptoPrices, rates, baseCurrency);
    let nextSnapshots = get().portfolioSnapshots;
    if (totalBase != null && totalBase > 0) {
      const todayKey = localDateKey(new Date());
      const snapshot: PortfolioSnapshot = {
        date: todayKey,
        valueBase: Math.round(totalBase * 100) / 100,
        baseCurrency,
        createdAt: new Date().toISOString(),
      };
      await db.portfolioSnapshots.put(snapshot);
      // Reload sorted asc; cheap since snapshots are at most one per day.
      nextSnapshots = await db.portfolioSnapshots.orderBy('date').toArray();
    }

    // Phase 3 (Tier 2): earnings calendar + dividends for held equities.
    // These have generous TTLs (12h / 7d) so won't hammer Finnhub on every
    // refresh — they're effectively a "once a day" workload that piggybacks
    // on the user's existing refresh tap. Also pull market news here so the
    // Finance Overview's news card stays fresh.
    const [earnings, dividendsMap, marketNews] = await Promise.all([
      equityTickers.length ? getEarningsCalendar(equityTickers) : Promise.resolve([]),
      equityTickers.length ? getDividendsAll(equityTickers) : Promise.resolve(new Map()),
      getMarketNews(),
    ]);
    const nextDividends: Record<string, DividendEvent[]> = { ...get().dividends };
    for (const [k, v] of dividendsMap) nextDividends[k] = v;

    set({
      stockQuotes: mergedStockQuotes,
      cryptoPrices: mergedCryptoPrices,
      fxRates: rates,
      companyProfiles: nextProfiles,
      sparklines: nextSparklines,
      portfolioSnapshots: nextSnapshots,
      upcomingEarnings: earnings,
      dividends: nextDividends,
      marketNews: marketNews.length ? marketNews : get().marketNews,
      refreshing: false,
      refreshErrors: [...lastProviderErrors],
      lastRefreshAt: Date.now(),
    });
    // v1.7 (BUG-2) — auto-realize dividends whose pay date has arrived. Each
    // newly-payable dividend not already in the ledger credits portfolio cash,
    // so projected dividend income becomes real instead of vanishing when the
    // date passes. Deterministic ids (see lib/dividendRealize.ts) keep this
    // idempotent across refreshes, reloads, and devices. The set is tiny (a
    // handful of dividends per refresh at most). Isolated try/catch so a bad
    // dividend row can't fail the whole refresh.
    try {
      const credits = computeDividendCredits(
        get().holdings,
        nextDividends,
        get().portfolioCashEntries,
        Date.now(),
        // v1.18.1 (NCC#152): credit ids are per owner.
        useSessionStore.getState().user?.id ?? guestDividendKey(),
      );
      for (const c of credits) {
        await addCashEntry(set, get, {
          id: c.id,
          type: 'dividend',
          amount: c.amount,
          currency: c.currency,
          relatedId: c.relatedId,
          note: c.note,
        });
      }
      if (credits.length) {
        console.log(`[refreshPortfolio] realized ${credits.length} dividend credit(s)`);
      }
    } catch (e) {
      console.warn('[refreshPortfolio] dividend realize failed:', (e as Error).message);
    }
    // adb logcat diagnostic: shows which tickers had quotes returned vs
    // requested. If the user has 10 holdings but only 3 returned data,
    // this surfaces the gap immediately:
    //   adb logcat | grep -i "refreshPortfolio\|nexus"
    console.log(
      '[refreshPortfolio] requested', equityTickers.length,
      'equity tickers; got', stockQuotes.length, 'quotes;',
      'errors:', lastProviderErrors.length,
    );
    if (lastProviderErrors.length) {
      for (const err of lastProviderErrors.slice(0, 10)) {
        console.warn(`[refreshPortfolio] ${err.provider}${err.ticker ? ' ' + err.ticker : ''}: ${err.message}`);
      }
    }
    } catch (e) {
      // Unexpected throw somewhere in the await chain — log it, surface in
      // refreshErrors so the user sees something, and lift the spinner.
      // Without this catch a single bad fetcher could leave refreshing=true
      // forever on the next launch.
      const msg = (e as Error).message || String(e);
      console.warn('[refreshPortfolio] caught:', msg);
      set({
        refreshing: false,
        refreshErrors: [
          ...lastProviderErrors,
          { provider: 'finnhub', message: `refresh threw: ${msg}` },
        ],
        lastRefreshAt: Date.now(),
      });
      return;
    }
    // Re-run the EoD tick so the 4:35pm backup notification's body reflects
    // the freshest quotes. Idempotent — runs cancel-or-schedule based on
    // current time-of-day in ET.
    void runPortfolioEodTick();
    // v1.15 Item 9 — quotes (and FX) for watched tickers were just written
    // above, so this is the moment a target can newly be crossed.
    void runWatchlistAlertsTick();
    // Eagerly populate per-holding news so the News screen renders without
    // each row needing to be opened. Fire-and-forget; failures are logged
    // but don't block the rest of the refresh from settling.
    void (async () => {
      await get().loadCompanyNewsForHoldings();
      // After per-holding news lands, score and fire any new alerts.
      // Sequencing matters: runNewsAlertsTick reads companyNews directly,
      // so without the await it would see the pre-refresh snapshot and
      // miss alerts for items that just arrived.
      await runNewsAlertsTick();
    })();
  },

  async loadCompanyNewsForHoldings() {
    const tickers = Array.from(
      new Set(
        get()
          .holdings.filter((h) => h.assetType === 'stock' || h.assetType === 'etf')
          .map((h) => h.ticker.toUpperCase()),
      ),
    );
    if (tickers.length === 0) return;
    // Fan out per-ticker fetches in parallel. getCompanyNews is cache-gated
    // (6h TTL) and rate-limit-gated at the api/cache layer, so this is safe
    // to call on every refresh — most tickers hit cache.
    const results = await Promise.all(
      tickers.map(async (t) => ({ ticker: t, news: await getCompanyNews(t) })),
    );
    const next: Record<string, NewsItem[]> = { ...get().companyNews };
    for (const r of results) {
      // Stamp ticker on each item so the News screen can render a badge.
      next[r.ticker] = r.news.map((n) => ({ ...n, ticker: r.ticker }));
    }
    set({ companyNews: next });
  },

  async fetchHoldingDetail(ticker) {
    const key = ticker.toUpperCase();
    if (get().detailLoading[key]) return; // already in-flight
    set({ detailLoading: { ...get().detailLoading, [key]: true } });
    try {
      const [metric, recommendations, news] = await Promise.all([
        getStockMetric(ticker),
        getRecommendations(ticker),
        getCompanyNews(ticker),
      ]);
      set({
        stockMetrics: metric
          ? { ...get().stockMetrics, [key]: metric }
          : get().stockMetrics,
        recommendations: { ...get().recommendations, [key]: recommendations },
        companyNews: { ...get().companyNews, [key]: news },
        detailLoading: { ...get().detailLoading, [key]: false },
      });
    } catch (e) {
      console.warn('[fetchHoldingDetail]', ticker, (e as Error).message);
      set({ detailLoading: { ...get().detailLoading, [key]: false } });
    }
  },

  async ensureBenchmarks() {
    // Skip if all benchmarks are already in state for this session. QQQ is
    // fetched even though the MacroStrip doesn't render it — the news
    // alerts module (runNewsAlertsTick) reads its `dp` to detect ≥1.5%
    // index moves alongside SPY. Cheap: cache-gated like the others.
    const haveSPY = get().stockQuotes.some((q) => q.ticker === 'SPY');
    const haveQQQ = get().stockQuotes.some((q) => q.ticker === 'QQQ');
    const haveIEUR = get().stockQuotes.some((q) => q.ticker === 'IEUR');
    const haveBTC = get().cryptoPrices?.prices.some((p) => p.id === 'bitcoin');
    if (haveSPY && haveQQQ && haveIEUR && haveBTC) return;
    const equityNeeded = [
      haveSPY ? null : 'SPY',
      haveQQQ ? null : 'QQQ',
      haveIEUR ? null : 'IEUR',
    ].filter((t): t is string => !!t);
    const cryptoNeeded = haveBTC ? [] : ['bitcoin'];
    const [equityResults, cryptoResult, ...sparkLists] = await Promise.all([
      equityNeeded.length ? getQuotes(equityNeeded) : Promise.resolve([]),
      cryptoNeeded.length ? getCryptoPrices(cryptoNeeded) : Promise.resolve(null),
      ...equityNeeded.map((t) => getYahooSparkline(t)),
    ]);
    const nextQuotes = [...get().stockQuotes, ...equityResults];
    let nextCrypto = get().cryptoPrices;
    if (cryptoResult) {
      // Merge benchmark crypto into existing prices.
      const existingPrices = nextCrypto?.prices ?? [];
      const newIds = new Set(cryptoResult.prices.map((p) => p.id));
      nextCrypto = {
        ...cryptoResult,
        prices: [...existingPrices.filter((p) => !newIds.has(p.id)), ...cryptoResult.prices],
      };
    }
    const nextSparklines = { ...get().sparklines };
    equityNeeded.forEach((t, i) => {
      const s = sparkLists[i] as number[] | null;
      if (s && s.length) nextSparklines[t.toUpperCase()] = s;
    });
    if (cryptoResult) {
      for (const p of cryptoResult.prices) {
        if (p.spark7d && p.spark7d.length) nextSparklines[p.id.toLowerCase()] = p.spark7d;
      }
    }
    set({ stockQuotes: nextQuotes, cryptoPrices: nextCrypto, sparklines: nextSparklines });
  },
}));

// v1.2 follow-up — CTO Account refactor. The BUG-6 bridge helpers that
// used to live here (`applyTransactionAssetDelta` +
// `reverseTransactionAssetDelta`) were removed. In the Account model an
// account's balance is DERIVED from the transactions hitting it (see
// `lib/accountBalance.ts:computeAccountBalance`), so the bridge's job —
// nudging the account's `value` by the transaction's signed amount on add
// / reverse on delete — is no longer needed. Keeping it would double-count.

// ─── helpers ──────────────────────────────────────────────────────────────

// ─── v1.3.2 — portfolio cash ledger helpers ────────────────────────────────
// Append a signed cash movement and persist + enqueue it. Used by buy/sell
// (auto) and deposit/withdrawal (explicit). `amount` sign convention: positive
// adds cash, negative removes it.
async function addCashEntry(
  setState: (partial: Partial<FinanceStore>) => void,
  getState: () => FinanceStore,
  input: {
    type: PortfolioCashEntryType;
    amount: number;
    currency: string;
    accountId?: string;
    relatedId?: string;
    note?: string;
    accountAmount?: number;
    accountCurrency?: string;
    /** Explicit deterministic PK (dividend auto-realize). Defaults to a fresh
     *  random UUID for the buy/sell/deposit/withdrawal paths. */
    id?: string;
  },
): Promise<void> {
  const entry: PortfolioCashEntry = {
    id: input.id ?? generateId(),
    type: input.type,
    amount: input.amount,
    currency: input.currency,
    accountId: input.accountId,
    relatedId: input.relatedId,
    note: input.note,
    // v1.18.1 (NCC#176) — local-only, see PortfolioCashEntry.accountAmount.
    ...(input.accountAmount != null && input.accountCurrency
      ? { accountAmount: input.accountAmount, accountCurrency: input.accountCurrency }
      : {}),
    createdAt: new Date().toISOString(),
    syncStatus: 'pending',
  };
  await db.portfolioCashEntries.add(entry);
  await enqueue('portfolio_cash_entry', entry.id, 'insert', entry);
  setState({ portfolioCashEntries: [...getState().portfolioCashEntries, entry] });
}

// Remove every cash entry linked to a lot/sale id (reverses its cash impact
// when the originating lot or sale is deleted/edited).
async function removeCashEntriesFor(
  setState: (partial: Partial<FinanceStore>) => void,
  getState: () => FinanceStore,
  relatedId: string,
): Promise<void> {
  const toRemove = getState().portfolioCashEntries.filter((e) => e.relatedId === relatedId);
  if (toRemove.length === 0) return;
  for (const e of toRemove) {
    await db.portfolioCashEntries.delete(e.id);
    await enqueue('portfolio_cash_entry', e.id, 'delete', { id: e.id });
  }
  setState({
    portfolioCashEntries: getState().portfolioCashEntries.filter((e) => e.relatedId !== relatedId),
  });
}

// Recompute a holding's cached aggregates (quantity + avgCostNative + costCurrency)
// from its lots, persist to Dexie, enqueue an update to the cloud, and patch
// the in-memory state. We collapse mixed currencies into the most-used one
// (last seen wins on tie); the convertSync layer at render time handles the
// resulting cross-currency math, so this is a display-string choice only.
async function recomputeHoldingAggregates(
  holdingId: string,
  lots: PortfolioLot[],
  setState: (partial: Partial<FinanceStore>) => void,
  getState: () => FinanceStore,
): Promise<void> {
  const holding = getState().holdings.find((h) => h.id === holdingId);
  if (!holding) return;
  const holdingLots = lots.filter((l) => l.holdingId === holdingId);
  if (holdingLots.length === 0) {
    // No lots — clear the cached cost fields but keep quantity untouched
    // (legacy holdings might still have a user-entered quantity we don't
    // want to wipe out just because they haven't recorded a lot yet).
    const updated: PortfolioHolding = {
      ...holding,
      avgCostNative: undefined,
      costCurrency: undefined,
    };
    await db.portfolioHoldings.put(updated);
    await enqueue('portfolio_holding', holdingId, 'update', updated);
    setState({
      holdings: getState().holdings.map((h) => (h.id === holdingId ? updated : h)),
    });
    return;
  }
  // Pick the dominant currency by lot count, tie-break by most recent lot.
  const currencyCounts = new Map<string, number>();
  for (const l of holdingLots) {
    currencyCounts.set(l.costCurrency, (currencyCounts.get(l.costCurrency) ?? 0) + 1);
  }
  const dominantCurrency = [...currencyCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  let totalQty = 0;
  let totalCost = 0;
  for (const l of holdingLots) {
    // v1.3.1 (BUG-23) — position size + cost basis net out FIFO-sold shares.
    // A fully-sold lot (remaining 0) contributes nothing; a partially-sold
    // lot contributes only its un-consumed remainder. This is what makes
    // h.quantity (the cached aggregate every consumer reads) the *current*
    // held position, and avgCostNative the cost basis of what's still held.
    const remaining = Math.max(0, l.quantity - (l.soldShares ?? 0));
    totalQty += remaining;
    // Mixed-currency lots: the cached avg is a display approximation only —
    // the real P/L math in Portfolio.tsx walks each lot via per-lot
    // convertSync. We sum naively in the dominant currency regardless.
    totalCost += remaining * l.costPerUnit;
  }
  const avgCost = totalQty > 0 ? totalCost / totalQty : undefined;
  const updated: PortfolioHolding = {
    ...holding,
    quantity: totalQty,
    avgCostNative: avgCost,
    costCurrency: dominantCurrency,
  };
  await db.portfolioHoldings.put(updated);
  await enqueue('portfolio_holding', holdingId, 'update', updated);
  setState({
    holdings: getState().holdings.map((h) => (h.id === holdingId ? updated : h)),
  });
}

function computeTotalBase(
  holdings: PortfolioHolding[],
  stockQuotes: QuoteResult[],
  cryptoPrices: CryptoResult | null,
  rates: Record<string, number> | null,
  baseCurrency: string,
): number | null {
  let total = 0;
  let anyPriced = false;
  for (const h of holdings) {
    if (h.assetType === 'stock' || h.assetType === 'etf') {
      const q = stockQuotes.find((s) => s.ticker === h.ticker);
      if (!q) continue;
      const native = q.quote.c * h.quantity;
      const conv = convertSync(native, q.currency, baseCurrency, rates);
      if (conv == null) continue;
      total += conv;
      anyPriced = true;
    } else {
      const p = cryptoPrices?.prices.find((p) => p.id === h.ticker);
      if (!p) continue;
      const nativeEur = p.priceEur * h.quantity;
      const conv = baseCurrency === 'EUR' ? nativeEur : convertSync(nativeEur, 'EUR', baseCurrency, rates);
      if (conv == null) continue;
      total += conv;
      anyPriced = true;
    }
  }
  return anyPriced ? total : null;
}
