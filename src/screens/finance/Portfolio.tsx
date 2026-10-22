import { useEffect, useMemo, useState } from 'react';
import { formatMoney } from '../../lib/currencies';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import AppHeader from '../../components/AppHeader';
import SparkLine from '../../components/SparkLine';
import DonutChart, { colorForIndex } from '../../components/DonutChart';
import PortfolioValueChart from '../../components/PortfolioValueChart';
import HoldingDetailSheet from '../../components/HoldingDetailSheet';
import HoldingsTable from '../../components/HoldingsTable';
import { useShellTier } from '../../lib/useShell';
import EarningsStrip from '../../components/EarningsStrip';
import DividendTracker from '../../components/DividendTracker';
import { isHoldingClosed } from '../../lib/positionStatus';
import { portfolioCashBalance } from '../../lib/portfolioCash';
import MacroStrip from '../../components/MacroStrip';
import InsightsCard from '../../components/InsightsCard';
import RatingPill from '../../components/RatingPill';
import RealizedPnLSection from '../../components/RealizedPnLSection';
import PortfolioCashCard from '../../components/PortfolioCashCard';
import { useFinanceStore } from '../../store/useFinanceStore';
import { useSettingsStore } from '../../store/useSettingsStore';
import { formatCacheAge, formatLocale } from '../../utils/formatters';
import { convertSync, normalizeCurrency } from '../../api/fxRates';
import { holdingValueBase } from '../../lib/positionValue';
import type { PortfolioHolding, PortfolioLot } from '../../types/finance';
import { isManuallyPriced } from '../../types/finance';
import { manualHoldingValue, manualPriceAgeDays } from '../../lib/manualValuation';
import type { QuoteResult } from '../../api/finnhub';
import type { CryptoResult } from '../../api/coingecko';
import type { CompanyProfile } from '../../api/companyProfile';
import { RackMasterBus, RackAllocation } from '../../components/RackPortfolio';
import { useActiveTheme } from '../../lib/theme';
import Glyph from '../../components/Glyph';


function fmt(amount: number, currency: string): string {
  return formatMoney(amount, currency, { locale: formatLocale() });
}

// Compact format for the row's value column — drops decimals on values ≥ 1000
// so a 5-digit holding doesn't push the % change off the row on narrow screens.
function fmtCompact(amount: number, currency: string): string {
  const d = Math.abs(amount) >= 1000 ? 0 : 2;
  return formatMoney(amount, currency, { locale: formatLocale(), min: d, max: d });
}

type AllocationView = 'class' | 'sector' | 'currency';

// Compute the position value, day change, cost basis, and P/L for a single
// holding in base currency. Returns null entries where data is missing so
// totals can decide whether to surface a "partial" flag.
interface PositionMetrics {
  holding: PortfolioHolding;
  valueBase: number | null;
  dayChangeBase: number | null;
  dayChangePct: number;
  costBase: number | null;
  plBase: number | null;
  plPct: number | null;
  currency: string; // quote/native currency for the row badge
  sector: string;   // for sector allocation; "Other" when unknown
  sparkKey: string; // map key for sparklines[]
  /** v1.19 (NCC#204): bonds and custom holdings: which price the value rests
   *  on, and how old a price the user entered is. No day change for them. */
  manual?: { basis: 'book' | 'manual'; ageDays: number | null };
}

// Cost basis from lots — sum each lot's (qty × pricePerUnit) converted to
// the user's base currency. Returns null when ANY lot fails to convert (the
// resulting total would be deceptively low). When no lots exist, falls back
// to the holding's legacy avgCostNative/quantity pair so pre-lots users
// still see P/L until they backfill purchase history.
function costBasisFromLots(
  h: PortfolioHolding,
  lots: PortfolioLot[],
  rates: Record<string, number> | null,
  baseCurrency: string,
): number | null {
  const holdingLots = lots.filter((l) => l.holdingId === h.id);
  if (holdingLots.length > 0) {
    let total = 0;
    for (const lot of holdingLots) {
      // v1.3.1 (BUG-23) — cost basis tracks CURRENTLY HELD shares, so it nets
      // out FIFO-sold shares to stay consistent with the net position value
      // (which reads h.quantity, also net). A fully-sold lot contributes 0.
      const remaining = Math.max(0, lot.quantity - (lot.soldShares ?? 0));
      const native = remaining * lot.costPerUnit;
      const conv = convertSync(native, lot.costCurrency, baseCurrency, rates);
      if (conv == null) return null;
      total += conv;
    }
    return total;
  }
  // Legacy fallback — avgCost × quantity. Only fires when the holding has no
  // lots yet (e.g. brand-new user who hasn't migrated, or someone who edited
  // a holding pre-lots model).
  if (h.avgCostNative != null && h.costCurrency && h.quantity > 0) {
    return convertSync(h.avgCostNative * h.quantity, h.costCurrency, baseCurrency, rates);
  }
  return null;
}

function metricsFor(
  h: PortfolioHolding,
  stockQuotes: QuoteResult[],
  cryptoPrices: CryptoResult | null,
  rates: Record<string, number> | null,
  baseCurrency: string,
  profiles: Record<string, CompanyProfile>,
  lots: PortfolioLot[],
): PositionMetrics {
  // Sector resolution order: user's manual override → Finnhub profile → fallback.
  // For ETFs we use "ETF" as the fallback so they don't all collapse into "Other"
  // when the user hasn't set a sector override yet.
  const resolveSector = (autoSector: string | undefined): string => {
    if (h.sectorOverride && h.sectorOverride.trim()) return h.sectorOverride.trim();
    if (autoSector && autoSector.trim()) return autoSector;
    if (h.assetType === 'etf') return 'ETF';
    if (h.assetType === 'crypto') return 'Crypto';
    return 'Other';
  };

  // v1.19 (NCC#204): bonds and custom holdings, valued from what the user
  // entered (lib/manualValuation.ts); no quote, no day change, no sparkline.
  if (isManuallyPriced(h.assetType)) {
    const mv = manualHoldingValue(h, lots, undefined, rates);
    const valueBase = holdingValueBase(h, stockQuotes, cryptoPrices, rates, baseCurrency, lots);
    const costBase = costBasisFromLots(h, lots, rates, baseCurrency);
    const plBase = valueBase != null && costBase != null ? valueBase - costBase : null;
    const plPct = costBase != null && costBase > 0 && plBase != null ? (plBase / costBase) * 100 : null;
    return {
      holding: h,
      valueBase,
      dayChangeBase: null,
      dayChangePct: 0,
      costBase,
      plBase,
      plPct,
      currency: mv?.currency ?? h.bond?.currency ?? h.manualPriceCurrency ?? baseCurrency,
      sector: resolveSector(h.assetType === 'bond' ? 'Bonds' : undefined),
      sparkKey: '',
      manual: { basis: mv?.basis ?? 'book', ageDays: h.manualPrice != null ? manualPriceAgeDays(h) : null },
    };
  }

  if (h.assetType === 'stock' || h.assetType === 'etf') {
    const q = stockQuotes.find((s) => s.ticker === h.ticker);
    const profile = profiles[h.ticker.toUpperCase()];
    if (!q) {
      return {
        holding: h,
        valueBase: null,
        dayChangeBase: null,
        dayChangePct: 0,
        costBase: null,
        plBase: null,
        plPct: null,
        currency: 'USD',
        sector: resolveSector(profile?.finnhubIndustry),
        sparkKey: h.ticker.toUpperCase(),
      };
    }
    // `native` survives only for the row's currency badge; the value itself
    // comes from the shared helper so this and InsightsCard cannot drift.
    const native = normalizeCurrency(q.quote.c * h.quantity, q.currency);
    const valueBase = holdingValueBase(h, stockQuotes, cryptoPrices, rates, baseCurrency);
    const dayNative = normalizeCurrency(q.quote.d * h.quantity, q.currency);
    const dayChangeBase = convertSync(dayNative.amount, dayNative.currency, baseCurrency, rates);
    const costBase = costBasisFromLots(h, lots, rates, baseCurrency);
    const plBase = valueBase != null && costBase != null ? valueBase - costBase : null;
    const plPct = costBase != null && costBase > 0 && plBase != null ? (plBase / costBase) * 100 : null;
    return {
      holding: h,
      valueBase,
      dayChangeBase,
      dayChangePct: q.quote.dp ?? 0,
      costBase,
      plBase,
      plPct,
      currency: native.currency,
      sector: resolveSector(profile?.finnhubIndustry),
      sparkKey: h.ticker.toUpperCase(),
    };
  }
  // crypto
  const p = cryptoPrices?.prices.find((p) => p.id === h.ticker);
  if (!p) {
    return {
      holding: h,
      valueBase: null,
      dayChangeBase: null,
      dayChangePct: 0,
      costBase: null,
      plBase: null,
      plPct: null,
      currency: 'EUR',
      sector: resolveSector(undefined),
      sparkKey: h.ticker.toLowerCase(),
    };
  }
  const valueBase = holdingValueBase(h, stockQuotes, cryptoPrices, rates, baseCurrency);
  // CoinGecko gives a 24h % directly. Approximate the 24h absolute change as
  // current_value × (pct/(100+pct)) so the math is consistent with how we'd
  // back out yesterday's price.
  const pct = p.change24h ?? 0;
  const dayChangeBase =
    valueBase != null && pct !== -100 ? valueBase * (pct / (100 + pct)) : null;
  const costBase = costBasisFromLots(h, lots, rates, baseCurrency);
  const plBase = valueBase != null && costBase != null ? valueBase - costBase : null;
  const plPct = costBase != null && costBase > 0 && plBase != null ? (plBase / costBase) * 100 : null;
  return {
    holding: h,
    valueBase,
    dayChangeBase,
    dayChangePct: pct,
    costBase,
    plBase,
    plPct,
    currency: 'EUR',
    sector: resolveSector(undefined),
    sparkKey: h.ticker.toLowerCase(),
  };
}

export default function Portfolio() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const holdings = useFinanceStore((s) => s.holdings);
  const portfolioLots = useFinanceStore((s) => s.portfolioLots);
  const cashEntries = useFinanceStore((s) => s.portfolioCashEntries);
  const stockQuotes = useFinanceStore((s) => s.stockQuotes);
  const cryptoPrices = useFinanceStore((s) => s.cryptoPrices);
  const fxRates = useFinanceStore((s) => s.fxRates);
  const companyProfiles = useFinanceStore((s) => s.companyProfiles);
  const sparklines = useFinanceStore((s) => s.sparklines);
  const snapshots = useFinanceStore((s) => s.portfolioSnapshots);
  const upcomingEarnings = useFinanceStore((s) => s.upcomingEarnings);
  const dividends = useFinanceStore((s) => s.dividends);
  const refreshPortfolio = useFinanceStore((s) => s.refreshPortfolio);
  const refreshing = useFinanceStore((s) => s.refreshing);
  const refreshErrors = useFinanceStore((s) => s.refreshErrors);
  const baseCurrency = useSettingsStore((s) => s.baseCurrency);

  const [allocationView, setAllocationView] = useState<AllocationView>('class');
  // Tap state for the detail sheet. Storing the full holding (not just the
  // id) keeps the sheet rendering its last frame during the slide-out
  // animation after onClose flips the parent's state.
  const [detailHolding, setDetailHolding] = useState<PortfolioHolding | null>(null);
  // v1.9 Item 14b — the dense table is a desktop-tier surface; phone and
  // tablet keep the card lists, which are the right shape for those widths.
  const isDesktop = useShellTier() === 'desktop';
  // v1.15 (Item 13) — Rack draws the totals as a master bus and the
  // allocation as channels; the free theme's cards are untouched.
  const rack = useActiveTheme() === 'rack';

  // Helper used by all three Tier 2 surfaces — looks up a holding by ticker
  // (case-insensitive, equity bias) and opens the detail sheet.
  const openDetailByTicker = (ticker: string) => {
    const up = ticker.toUpperCase();
    const h = holdings.find(
      (h) => h.ticker.toUpperCase() === up && (h.assetType === 'stock' || h.assetType === 'etf'),
    );
    if (h) setDetailHolding(h);
  };

  useEffect(() => {
    refreshPortfolio();
  }, [refreshPortfolio]);

  const oldestAge = useMemo(() => {
    const ages: number[] = [];
    for (const q of stockQuotes) ages.push(q.ageMinutes);
    if (cryptoPrices) ages.push(cryptoPrices.ageMinutes);
    return ages.length ? Math.max(...ages) : 0;
  }, [stockQuotes, cryptoPrices]);

  const anyStale = stockQuotes.some((q) => q.stale) || cryptoPrices?.stale;

  // Compute per-position metrics once and reuse for totals, allocation, list.
  const positions = useMemo(
    () =>
      holdings.map((h) =>
        metricsFor(h, stockQuotes, cryptoPrices, fxRates, baseCurrency, companyProfiles, portfolioLots),
      ),
    [holdings, stockQuotes, cryptoPrices, fxRates, baseCurrency, companyProfiles, portfolioLots],
  );

  // Uninvested portfolio cash (sale proceeds + deposits − buys − withdrawals),
  // in base currency. Counts toward total portfolio value and the allocation
  // donut — same figure Net Worth folds into the portfolio side.
  const cash = useMemo(
    () => portfolioCashBalance(cashEntries, baseCurrency, fxRates),
    [cashEntries, baseCurrency, fxRates],
  );

  // v1.7 (BUG-2) — dividends realized so far this calendar year, base currency.
  // Sourced from the auto-realized `dividend` cash-ledger entries (which also
  // fold into the `cash` balance above). Surfaces in DividendTracker so the
  // user sees projected income actually being captured, not just projected.
  const realizedDividendYtd = useMemo(() => {
    const yearPrefix = new Date().getFullYear().toString();
    let total = 0;
    for (const e of cashEntries) {
      if (e.type !== 'dividend') continue;
      if (!e.createdAt.startsWith(yearPrefix)) continue;
      total += convertSync(e.amount, e.currency, baseCurrency, fxRates) ?? 0;
    }
    return total;
  }, [cashEntries, baseCurrency, fxRates]);

  const totals = useMemo(() => {
    let positionsValue = 0;
    let dayChange = 0;
    let cost = 0;
    let pl = 0;
    let missingFx = false;
    let hasCost = false;
    for (const p of positions) {
      if (p.valueBase != null) positionsValue += p.valueBase; else missingFx = true;
      if (p.dayChangeBase != null) dayChange += p.dayChangeBase;
      if (p.costBase != null) {
        cost += p.costBase;
        hasCost = true;
      }
      if (p.plBase != null) pl += p.plBase;
    }
    // Headline value includes cash; day-change % stays scoped to invested
    // positions (cash doesn't move day to day) so the percentage isn't diluted.
    const total = positionsValue + cash;
    const dayPct = positionsValue - dayChange > 0 ? (dayChange / (positionsValue - dayChange)) * 100 : 0;
    const plPct = cost > 0 ? (pl / cost) * 100 : null;
    return { total, positionsValue, cash, dayChange, dayPct, cost, pl, plPct, missingFx, hasCost };
  }, [positions, cash]);

  // Allocation slices for the donut. Three views; same shape so the donut
  // component is reusable across the toggle. ETF is now a first-class
  // bucket so a holding tagged as such gets its own slice instead of being
  // grouped with regular stocks.
  const allocationSlices = useMemo(() => {
    const buckets = new Map<string, number>();
    for (const p of positions) {
      if (p.valueBase == null) continue;
      let key: string;
      if (allocationView === 'class') {
        key = p.holding.assetType === 'stock'
          ? 'Stocks'
          : p.holding.assetType === 'etf'
            ? 'ETFs'
            : p.holding.assetType === 'bond'
              ? 'Bonds'
              : p.holding.assetType === 'custom'
                ? 'Other'
                : 'Crypto';
      } else if (allocationView === 'sector') {
        key = p.sector;
      } else {
        key = p.currency.toUpperCase();
      }
      buckets.set(key, (buckets.get(key) ?? 0) + p.valueBase);
    }
    // Cash is part of the allocation. In class/sector views it's its own
    // "Cash" slice; in the currency view it lives in its native bucket (the
    // balance is already collapsed to base currency). Only add a positive
    // balance — a negative (owed) cash position can't be drawn as a slice.
    if (cash > 1e-9) {
      const cashKey = allocationView === 'currency' ? baseCurrency.toUpperCase() : 'Cash';
      buckets.set(cashKey, (buckets.get(cashKey) ?? 0) + cash);
    }
    // Sort largest first so the legend reads top-down.
    return Array.from(buckets.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([label, value]) => ({ label, value }));
  }, [positions, allocationView, cash, baseCurrency]);

  const sources = useMemo(() => {
    const set = new Set(stockQuotes.map((q) => q.source));
    return Array.from(set);
  }, [stockQuotes]);

  const stockBadge =
    sources.length === 0
      ? t('fin.port.stocksBadge')
      : sources.length === 1
        ? sources[0].toUpperCase()
        : 'FINNHUB + YAHOO';

  // Fully-exited positions (bought then entirely sold) archive into the
  // Closed-positions collapsible inside RealizedPnLSection — they drop out of
  // the live lists, dividend projection, and Manage Holdings here. Shared
  // definition in lib/positionStatus so every surface agrees.
  const openHoldings = useMemo(
    () => holdings.filter((h) => !isHoldingClosed(h, portfolioLots)),
    [holdings, portfolioLots],
  );

  // Sort holdings by value desc for display so the "important" ones surface.
  // Stocks and ETFs share a section since they share the same quote pipeline
  // (Finnhub + Yahoo); crypto stays separate (CoinGecko).
  const sortedEquities = useMemo(
    () =>
      positions
        .filter((p) => p.holding.assetType === 'stock' || p.holding.assetType === 'etf')
        .filter((p) => !isHoldingClosed(p.holding, portfolioLots))
        .sort((a, b) => (b.valueBase ?? 0) - (a.valueBase ?? 0)),
    [positions, portfolioLots],
  );
  const sortedCryptos = useMemo(
    () =>
      positions
        .filter((p) => p.holding.assetType === 'crypto')
        .filter((p) => !isHoldingClosed(p.holding, portfolioLots))
        .sort((a, b) => (b.valueBase ?? 0) - (a.valueBase ?? 0)),
    [positions, portfolioLots],
  );
  // v1.19 (NCC#204): bonds and custom holdings, their own section.
  const sortedManual = useMemo(
    () =>
      positions
        .filter((p) => isManuallyPriced(p.holding.assetType))
        .filter((p) => !isHoldingClosed(p.holding, portfolioLots))
        .sort((a, b) => (b.valueBase ?? 0) - (a.valueBase ?? 0)),
    [positions, portfolioLots],
  );

  return (
    <>
      <AppHeader
        title={t('fin.ov.portfolio')}
        back="/finance"
        backLabel={t('fin.finance')}
        showAvatar={false}
        action={
          <>
            <button
              onClick={() => navigate('/finance/portfolio/watchlist')}
              className="text-xs px-2 py-1 rounded-sm border border-border text-text-muted active:text-text active:border-border"
            >
              <Glyph name="watch" size={13} />
            </button>
            <button
              onClick={() => navigate('/finance/portfolio/manage')}
              className="text-xs px-2 py-1 rounded-sm border border-border text-text-muted active:text-text active:border-border"
            >
              {t('fin.ov.manage')}
            </button>
            <button
              onClick={() => refreshPortfolio()}
              className="chip press-spring"
              disabled={refreshing}
            >
              {refreshing ? '…' : '↻'}
            </button>
          </>
        }
      />
      <div className="space-y-3">
        {/* Benchmarks — small strip at top giving "how is the market doing" context */}
        <MacroStrip />

        {(anyStale || oldestAge > 60 || refreshErrors.length > 0) && (
          <div className="alert alert-warn">
            <span className="w-2 h-2 rounded-full bg-warning" />
            <div className="flex-1 min-w-0">
              <div className="font-semibold">
                {refreshErrors.length > 0
                  ? t('fin.port.fetchErrors', { count: refreshErrors.length })
                  : t('fin.port.cacheAge', { age: formatCacheAge(oldestAge) })}
              </div>
              {refreshErrors.length === 0 && (
                <div className="text-[0.625rem] opacity-80">
                  {t('fin.port.cachedDataHint')}
                </div>
              )}
              {/* Expanded per-ticker error list — surfaces exactly which
                  holdings failed and why. Capped at 8 so the alert doesn't
                  push the rest of the screen off; the adb logcat dump in
                  refreshPortfolio has the complete list for debugging. */}
              {refreshErrors.length > 0 && (
                <div className="text-[0.625rem] opacity-90 mt-1 space-y-0.5 font-mono">
                  {refreshErrors.slice(0, 8).map((e, i) => (
                    <div key={i} className="truncate">
                      · {e.provider}
                      {e.ticker ? ` ${e.ticker}` : ''}: {e.message}
                    </div>
                  ))}
                  {refreshErrors.length > 8 && (
                    <div className="opacity-60">
                      {t('fin.port.moreErrors', { count: refreshErrors.length - 8 })}
                    </div>
                  )}
                </div>
              )}
            </div>
            <button onClick={() => refreshPortfolio()} className="btn-ghost btn-sm flex-shrink-0">
              {t('fin.port.retry')}
            </button>
          </div>
        )}

        {rack ? (
          <RackMasterBus
            total={totals.total}
            dayChange={totals.dayChange}
            dayPct={totals.dayPct}
            snapshots={snapshots}
            baseCurrency={baseCurrency}
            fmt={fmt}
            cost={totals.hasCost ? totals.cost : null}
            pl={totals.hasCost ? totals.pl : null}
            plPct={totals.hasCost ? totals.plPct : null}
            note={<>{totals.missingFx ? t('fin.port.partial') : ''}{t('fin.port.cached')}{oldestAge > 0 ? formatCacheAge(oldestAge) : t('fin.port.fresh')}</>}
          />
        ) : (<>
        {/* Totals card — value, day change, cost basis, P/L */}
        <div className="card-elevated">
          <div className="text-[0.625rem] uppercase tracking-[0.15em] text-text-muted mb-1">
            {t('fin.port.totalValue')}
          </div>
          <div className="font-heading font-bold text-3xl tracking-tight">
            {fmt(totals.total, baseCurrency)}
          </div>
          <div className="flex items-center gap-3 mt-1 text-xs">
            <span className={totals.dayChange >= 0 ? 'text-success' : 'text-danger'}>
              {totals.dayChange >= 0 ? '↑' : '↓'} {fmt(Math.abs(totals.dayChange), baseCurrency)}
              {' '}
              <span className="opacity-70">({t('fin.port.todayPct', { pct: Math.abs(totals.dayPct).toFixed(2) })})</span>
            </span>
          </div>
          {Math.abs(totals.cash) > 1e-9 && (
            <div className="text-[0.625rem] text-text-muted mt-1">
              {t('fin.port.holdingsInclCash', { holdings: fmt(totals.positionsValue, baseCurrency), cash: fmt(totals.cash, baseCurrency) })}
            </div>
          )}
          {totals.hasCost && (
            <div className="flex items-center justify-between mt-3 pt-3 border-t border-border/40 text-xs">
              <div>
                <div className="text-[0.625rem] uppercase tracking-wider text-text-muted">{t('fin.port.cost')}</div>
                <div className="font-medium">{fmt(totals.cost, baseCurrency)}</div>
              </div>
              <div className="text-end">
                <div className="text-[0.625rem] uppercase tracking-wider text-text-muted">{t('fin.port.totalPL')}</div>
                <div className={`font-medium ${totals.pl >= 0 ? 'text-success' : 'text-danger'}`}>
                  {totals.pl >= 0 ? '+' : '−'}{fmt(Math.abs(totals.pl), baseCurrency)}
                  {totals.plPct != null && (
                    <span className="opacity-70 ms-1">({totals.pl >= 0 ? '+' : ''}{totals.plPct.toFixed(1)}%)</span>
                  )}
                </div>
              </div>
            </div>
          )}
          <div className="text-[0.625rem] text-text-muted mt-2">
            {totals.missingFx ? t('fin.port.partial') : ''}
            {t('fin.port.cached')}{oldestAge > 0 ? formatCacheAge(oldestAge) : t('fin.port.fresh')}
            {!totals.hasCost && holdings.length > 0 && (
              <> · {t('fin.port.addCostPre')} <span className="text-primary">{t('fin.ov.manage')}</span> {t('fin.port.addCostPost')}</>
            )}
          </div>
        </div>

        </>)}

        {/* Portfolio value history */}
        <PortfolioValueChart
          snapshots={snapshots}
          baseCurrency={baseCurrency}
          formatCurrency={fmt}
        />

        {rack ? (
          <RackAllocation
            rows={positions
              .filter((p) => p.valueBase != null && p.valueBase > 0)
              .map((p) => ({
                key: p.holding.id,
                ticker: p.holding.ticker,
                value: p.valueBase as number,
                dayPct: p.dayChangePct,
                onClick: () => setDetailHolding(p.holding),
              }))}
            total={totals.total}
            positionsValue={totals.positionsValue}
            baseCurrency={baseCurrency}
            fmt={fmt}
          />
        ) : (<>
        {/* Allocation donut */}
        {allocationSlices.length > 0 && (
          <div className="card">
            <div className="flex items-center justify-between mb-3">
              <span className="font-heading font-semibold text-sm">{t('fin.port.allocation')}</span>
              <div className="flex gap-1">
                {(['class', 'sector', 'currency'] as AllocationView[]).map((v) => (
                  <button
                    key={v}
                    onClick={() => setAllocationView(v)}
                    className={`text-[0.625rem] uppercase tracking-wider px-1.5 py-0.5 rounded-sm border ${
                      allocationView === v
                        ? 'border-primary/40 bg-primary/5 text-primary'
                        : 'border-border text-text-muted'
                    }`}
                  >
                    {v === 'class' ? t('fin.port.viewClass') : v === 'sector' ? t('fin.port.viewSector') : t('fin.port.viewCurrency')}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex items-center gap-4">
              <DonutChart
                data={allocationSlices}
                size={120}
                thickness={20}
                centerTop={fmtCompact(totals.total, baseCurrency)}
                centerBottom={allocationView === 'class' ? t('fin.port.classesCount', { count: allocationSlices.length }) : allocationView === 'sector' ? t('fin.port.sectorsCount', { count: allocationSlices.length }) : t('fin.port.currCount', { count: allocationSlices.length })}
              />
              <div className="flex-1 min-w-0 space-y-1.5">
                {allocationSlices.map((s, i) => {
                  const pct = totals.total > 0 ? (s.value / totals.total) * 100 : 0;
                  return (
                    <div key={s.label} className="flex items-center gap-2 text-xs">
                      <span
                        className="w-2.5 h-2.5 rounded-sm flex-shrink-0"
                        style={{ backgroundColor: colorForIndex(i) }}
                      />
                      <span className="flex-1 min-w-0 truncate">{t(`fin.port.cls${s.label}`, { defaultValue: s.label })}</span>
                      <span className="text-text-muted text-[0.625rem]">
                        {pct.toFixed(0)}%
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        </>)}

        {/* Insights — auto-generated observations from existing data */}
        <InsightsCard />

        {/* Earnings calendar — only renders when there's at least one upcoming event */}
        <EarningsStrip events={upcomingEarnings} onTapTicker={openDetailByTicker} />

        {/* Dividends — projected annual income + per-position breakdown */}
        <DividendTracker
          holdings={openHoldings}
          dividends={dividends}
          fxRates={fxRates}
          baseCurrency={baseCurrency}
          formatCurrency={fmt}
          realizedYtd={realizedDividendYtd}
          onTapTicker={openDetailByTicker}
        />

        {/* v1.9 Item 14b — at the desktop tier the two card lists collapse into
            one dense table. The split into "Stocks + ETFs" and "Crypto" exists
            because a phone can only show a handful of fields, so grouping is
            how you tell positions apart; a table has a Sector column doing
            that job, and splitting it would just mean two scroll regions and
            two totals. Below 1201px nothing changes — the cards are untouched. */}
        {isDesktop ? (
          <HoldingsTable
            rows={positions}
            totalBase={totals.total}
            baseCurrency={baseCurrency}
            onSelect={setDetailHolding}
          />
        ) : (
        <>
        {/* Stocks + ETFs list — value, P/L, sparkline */}
        <div className="card">
          <div className="flex items-center justify-between mb-3">
            <span className="font-heading font-semibold text-sm">{t('fin.port.stocksEtfs')}</span>
            <span className="text-[0.5625rem] uppercase tracking-wider text-primary border border-primary/40 bg-primary/5 rounded-sm px-1.5 py-0.5">
              {stockBadge}
            </span>
          </div>
          {sortedEquities.length === 0 && (
            <div className="text-xs text-text-muted text-center py-3">
              {refreshing ? t('fin.port.loadingQuotes') : t('fin.port.noQuotes')}
            </div>
          )}
          {sortedEquities.map((p) => (
            <HoldingRow
              key={p.holding.id}
              position={p}
              sparkline={sparklines[p.sparkKey]}
              baseCurrency={baseCurrency}
              weightPct={totals.total > 0 && p.valueBase != null ? (p.valueBase / totals.total) * 100 : null}
              onTap={() => setDetailHolding(p.holding)}
            />
          ))}
        </div>

        {/* Crypto list */}
        <div className="card">
          <div className="flex items-center justify-between mb-3">
            <span className="font-heading font-semibold text-sm">{t('fin.port.crypto')}</span>
            <span className="text-[0.5625rem] uppercase tracking-wider text-success border border-success/40 bg-success/5 rounded-sm px-1.5 py-0.5">
              CoinGecko
            </span>
          </div>
          {sortedCryptos.length === 0 && (
            <div className="text-xs text-text-muted text-center py-3">
              {refreshing ? t('fin.port.loadingPrices') : t('fin.port.noPrices')}
            </div>
          )}
          {sortedCryptos.map((p) => (
            <HoldingRow
              key={p.holding.id}
              position={p}
              sparkline={sparklines[p.sparkKey]}
              baseCurrency={baseCurrency}
              weightPct={totals.total > 0 && p.valueBase != null ? (p.valueBase / totals.total) * 100 : null}
              onTap={() => setDetailHolding(p.holding)}
            />
          ))}
        </div>

        {/* v1.19 (NCC#204): bonds and custom-priced holdings. */}
        {sortedManual.length > 0 && (
          <div className="card">
            <div className="flex items-center justify-between mb-3">
              <span className="font-heading font-semibold text-sm">{t('bonds.section')}</span>
              <span className="text-[0.5625rem] uppercase tracking-wider text-text-muted border border-border rounded-sm px-1.5 py-0.5">
                {t('bonds.noFeed')}
              </span>
            </div>
            {sortedManual.map((p) => (
              <HoldingRow
                key={p.holding.id}
                position={p}
                sparkline={undefined}
                baseCurrency={baseCurrency}
                weightPct={totals.total > 0 && p.valueBase != null ? (p.valueBase / totals.total) * 100 : null}
                onTap={() => navigate(`/finance/portfolio/lots/${p.holding.id}`)}
              />
            ))}
          </div>
        )}
        </>
        )}

        {/* v1.3.2 — portfolio cash (proceeds + deposits − buys − withdrawals),
            with deposit/withdraw transfers to/from a liquid account. */}
        <PortfolioCashCard />

        {/* v1.3.1 (BUG-23) — realized P/L + closed positions. Renders nothing
            until the first sale is recorded. */}
        <RealizedPnLSection />
      </div>
      <HoldingDetailSheet holding={detailHolding} onClose={() => setDetailHolding(null)} />
    </>
  );
}

// One holding's row. Three columns: identity (ticker + sub), sparkline,
// value (current + day % + P/L line). Designed for tap-density: ~64px high.
// Tapping anywhere on the row opens the detail sheet.
//
// The thin bar at the bottom shows this holding's share of total portfolio
// value — a passive at-a-glance ranking that complements the explicit % shown
// in the identity sub-label. Highlighted when the weight crosses 25% (a soft
// concentration signal — the explicit insight still fires at 30%).
function HoldingRow({
  position,
  sparkline,
  baseCurrency,
  weightPct,
  onTap,
}: {
  position: PositionMetrics;
  sparkline: number[] | undefined;
  baseCurrency: string;
  weightPct: number | null;
  onTap?: () => void;
}) {
  const { t } = useTranslation();
  const { holding, valueBase, dayChangePct, plBase, plPct, currency, manual } = position;
  const trend = dayChangePct >= 0 ? 'up' : 'down';
  const weightLabel = weightPct != null
    ? weightPct >= 10
      ? `${weightPct.toFixed(0)}%`
      : `${weightPct.toFixed(1)}%`
    : null;
  // Clamp the bar fill so we never overshoot the track when an FX hiccup
  // briefly skews one position above 100%.
  const barFill = weightPct != null ? Math.max(0, Math.min(100, weightPct)) : 0;
  const heavy = weightPct != null && weightPct >= 25;
  return (
    <button
      onClick={onTap}
      className="w-full py-2 border-b border-border/40 last:border-0 active:bg-surface2/40 text-start"
    >
      <div className="flex items-center gap-2">
        <div className="flex flex-col min-w-0 w-[68px]">
          <span className="text-sm font-medium truncate">{holding.ticker.toUpperCase()}</span>
          <span className="text-[0.5625rem] uppercase tracking-wider text-text-muted truncate">
            {holding.assetType === 'etf' ? `ETF · ${currency}` : holding.assetType === 'bond' ? `${t('bonds.bond')} · ${currency}` : currency}
            {weightLabel && (
              <>
                {' · '}
                <span className={heavy ? 'text-primary' : 'text-text-muted'}>{weightLabel}</span>
              </>
            )}
          </span>
          {/* v1.2 — Insights tier pill. Only for stock/ETF (no crypto/cash
              ratings yet). RatingPill renders an unobtrusive placeholder when
              no rating has been computed. Compact mode keeps the row tight. */}
          {(holding.assetType === 'stock' || holding.assetType === 'etf') && (
            <span className="mt-1">
              <RatingPill ticker={holding.ticker} compact />
            </span>
          )}
        </div>
        <div className="flex-1 min-w-0 px-1">
          {sparkline && sparkline.length >= 2 ? (
            <SparkLine data={sparkline} height={28} trend={trend} />
          ) : (
            <div className="h-7" />
          )}
        </div>
        <div className="flex flex-col items-end min-w-0">
          <span className="text-sm whitespace-nowrap">
            {valueBase != null ? fmtCompact(valueBase, baseCurrency) : '—'}
          </span>
          {manual ? (
            // v1.19 (NCC#204): which price the value rests on, not a day move.
            <span className="text-[0.5625rem] uppercase tracking-wider whitespace-nowrap text-text-muted">
              {manual.basis === 'book'
                ? t('bonds.basisBook')
                : manual.ageDays != null
                  ? t('bonds.basisManualAge', { count: manual.ageDays })
                  : t('bonds.basisManual')}
            </span>
          ) : (
            <span className={`text-[0.625rem] whitespace-nowrap ${dayChangePct >= 0 ? 'text-success' : 'text-danger'}`}>
              {dayChangePct >= 0 ? '↑' : '↓'} {Math.abs(dayChangePct).toFixed(2)}%
            </span>
          )}
          {plBase != null && plPct != null && (
            <span className={`text-[0.5625rem] whitespace-nowrap ${plBase >= 0 ? 'text-success' : 'text-danger'} opacity-80`}>
              {plBase >= 0 ? '+' : '−'}{fmtCompact(Math.abs(plBase), baseCurrency)}{' '}
              ({plBase >= 0 ? '+' : ''}{plPct.toFixed(1)}%)
            </span>
          )}
        </div>
      </div>
      {weightPct != null && (
        <div className="mt-1.5 h-[3px] rounded-full bg-surface2/60 overflow-hidden">
          <div
            className={`h-full ${heavy ? 'bg-primary' : 'bg-primary/40'}`}
            style={{ width: `${barFill}%` }}
          />
        </div>
      )}
    </button>
  );
}
