import { useMemo, useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router-dom';
import AppHeader from '../../components/AppHeader';
import StatCard from '../../components/StatCard';
import ProgressBar from '../../components/ProgressBar';
import RowActions from '../../components/RowActions';
import NewsCard from '../../components/NewsCard';
import HeatmapCalendar from '../../components/HeatmapCalendar';
import CashFlowForecastCard from '../../components/CashFlowForecastCard';
import MarketsSegment from '../../components/MarketsSegment';
import { useFinanceStore } from '../../store/useFinanceStore';
import { useSettingsStore } from '../../store/useSettingsStore';
import { convertSync, normalizeCurrency } from '../../api/fxRates';
import { formatCurrency, formatShortDate, localDateKey, formatLocale, parseDateLocal } from '../../utils/formatters';
import { computeAccountBalance } from '../../lib/accountBalance';
import CashFlowDiagram from '../../components/CashFlowDiagram';
import BudgetTrendTable from '../../components/BudgetTrendTable';
import { buildCashFlow } from '../../lib/cashFlow';
import { buildBudgetTrend } from '../../lib/budgetTrend';
import { formatMoney } from '../../lib/currencies';
import { useShellTier } from '../../lib/useShell';
import { portfolioCashBalance } from '../../lib/portfolioCash';
import Glyph from '../../components/Glyph';
import { isManuallyPriced } from '../../types/finance';
import { manualHoldingValueBase } from '../../lib/manualValuation';

// v1.3 BUG-18 — Finance is split into two segments. "Balance" carries the
// cash-flow + net-worth + budgeting surface; "Portfolio" carries the
// investing + market surface. The former flat hierarchy (five header chips
// + everything stacked at one level) read as bloated; the segmented control
// gives the page a clear two-view spine.
// v1.4 — a third "Markets" segment joins Balance + Portfolio: a macro snapshot
// (indices, FX, rates, commodities, economic calendar). Read-only, fetched at
// runtime — no persistence.
type FinanceTab = 'balance' | 'portfolio' | 'markets';
const FINANCE_TABS: readonly FinanceTab[] = ['balance', 'portfolio', 'markets'];

/**
 * v1.9 Item 14b #3 — ONE filter for every drill-in on this screen.
 *
 * The cash-flow diagram and the budget grid both narrow the transaction list
 * below them. Two independent filter states would let the two surfaces
 * contradict each other on screen, with the list obeying whichever fired last
 * and no way to tell which. Month is part of the filter because both sources
 * are month-scoped — the diagram draws the current month, the grid draws one
 * cell — and filtering a month-scoped click to all-time was the earlier
 * version's mismatch.
 *
 * `categoryId: null` means uncategorised spending specifically, matching the
 * budget grid's own uncategorised row.
 */
interface TxFilter {
  categoryId: string | null;
  /** `YYYY-MM`. */
  month: string;
  label: string;
}

function monthRange(key: string): { from: string; to: string } {
  const [y, m] = key.split('-').map(Number);
  const last = new Date(y, m, 0).getDate();
  return { from: `${key}-01`, to: `${key}-${String(last).padStart(2, '0')}` };
}

export default function FinanceOverview() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const transactions = useFinanceStore((s) => s.transactions);
  const budgetCategories = useFinanceStore((s) => s.budgetCategories);
  const deleteTransaction = useFinanceStore((s) => s.deleteTransaction);
  const holdings = useFinanceStore((s) => s.holdings);
  const portfolioLots = useFinanceStore((s) => s.portfolioLots);
  const stockQuotes = useFinanceStore((s) => s.stockQuotes);
  const cryptoPrices = useFinanceStore((s) => s.cryptoPrices);
  const fxRates = useFinanceStore((s) => s.fxRates);
  const manualAssets = useFinanceStore((s) => s.manualAssets);
  const portfolioCashEntries = useFinanceStore((s) => s.portfolioCashEntries);
  const baseCurrency = useSettingsStore((s) => s.baseCurrency);

  // Active segment. Seeds from a `?tab=` query param so a deep link (e.g. a
  // market-news notification, which routes to /finance?tab=portfolio now that
  // the standalone News screen is gone) lands on the right view. The effect
  // keeps it in sync if the param changes while the screen is already mounted.
  const [tab, setTab] = useState<FinanceTab>(() => {
    const t = searchParams.get('tab');
    return t === 'portfolio' || t === 'markets' ? t : 'balance';
  });
  useEffect(() => {
    const t = searchParams.get('tab');
    // HYG-4: The tab is moved both by the URL and by tapping, so it cannot be derived
    // from searchParams alone.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (t === 'portfolio' || t === 'balance' || t === 'markets') setTab(t);
  }, [searchParams]);

  // Net worth summary — MUST match the Net Worth detail screen exactly:
  //   net worth = portfolio holdings value + portfolio cash
  //               + Σ(derived account balances, liabilities already negative)
  // Two things this previously got wrong and drifted from the detail screen:
  //   1. portfolio cash was omitted (the detail screen folds it into the
  //      portfolio side), and
  //   2. account balances used the stored opening figure `a.value` instead of
  //      the DERIVED balance (opening + transaction deltas) the Account
  //      refactor introduced. We now use computeAccountBalance, same as the
  //      detail screen, so the headline number and the drill-in agree.
  const netWorth = useMemo(() => {
    let portfolioBase = 0;
    for (const h of holdings) {
      if (isManuallyPriced(h.assetType)) {
        // v1.19 (NCC#204): bonds and custom holdings carry their own price.
        const v = manualHoldingValueBase(h, portfolioLots, fxRates, baseCurrency);
        if (v != null) portfolioBase += v;
      } else if (h.assetType === 'stock' || h.assetType === 'etf') {
        const q = stockQuotes.find((s) => s.ticker === h.ticker);
        if (!q) continue;
        const native = normalizeCurrency(q.quote.c * h.quantity, q.currency);
        const conv = convertSync(native.amount, native.currency, baseCurrency, fxRates);
        if (conv != null) portfolioBase += conv;
      } else {
        const p = cryptoPrices?.prices.find((p) => p.id === h.ticker);
        if (!p) continue;
        const native = p.priceEur * h.quantity;
        const conv = baseCurrency === 'EUR' ? native : convertSync(native, 'EUR', baseCurrency, fxRates);
        if (conv != null) portfolioBase += conv;
      }
    }
    const cashBase = portfolioCashBalance(portfolioCashEntries, baseCurrency, fxRates);
    // Signed sum of every account's derived balance — liability accounts carry
    // a negative balance by convention, so this is assets − liabilities.
    let accountsBase = 0;
    for (const a of manualAssets) {
      const native = computeAccountBalance(a, transactions, fxRates, baseCurrency).balance;
      const conv = a.currency === baseCurrency
        ? native
        : convertSync(native, a.currency, baseCurrency, fxRates);
      if (conv != null) accountsBase += conv;
    }
    return {
      total: portfolioBase + cashBase + accountsBase,
      hasData: holdings.length > 0 || manualAssets.length > 0 || portfolioCashEntries.length > 0,
    };
  }, [holdings, portfolioLots, stockQuotes, cryptoPrices, fxRates, manualAssets, transactions, portfolioCashEntries, baseCurrency]);

  // v1.9 Item 14b #2 — cash-flow diagram, desktop tier only. The month bounds
  // are ISO strings rather than Date objects: no timezone in play, so a
  // transaction stays in the month the user filed it under.
  const isDesktop = useShellTier() === 'desktop';
  const [txFilter, setTxFilter] = useState<TxFilter | null>(null);
  const [budgetMonths, setBudgetMonths] = useState(6);

  const currentMonthKey = useMemo(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  }, []);

  // Labels live here so both the diagram and the budget grid feed the same
  // aggregation with the same names — `buildCashFlow` stays i18n-free.
  const flowLabels = useMemo(
    () => ({
      otherIncome: t('fin.flow.otherIncome'),
      uncategorised: t('fin.flow.uncategorised'),
      saved: t('fin.flow.saved'),
      debt: t('fin.flow.debt'),
      leftover: t('fin.flow.leftover'),
      deficit: t('fin.flow.fromReserves'),
    }),
    [t],
  );

  const cashFlow = useMemo(() => {
    const { from, to } = monthRange(currentMonthKey);
    return buildCashFlow({
      transactions,
      categories: budgetCategories,
      accounts: manualAssets,
      from,
      to,
      labels: flowLabels,
    });
  }, [transactions, budgetCategories, manualAssets, currentMonthKey, flowLabels]);

  // v1.9 Item 14b #6 — same aggregation, run once per month. Built here rather
  // than inside the table so the two desktop surfaces provably read one number.
  const budgetTrend = useMemo(
    () =>
      buildBudgetTrend({
        transactions,
        categories: budgetCategories,
        accounts: manualAssets,
        months: budgetMonths,
        today: localDateKey(new Date()),
        labels: flowLabels,
      }),
    [transactions, budgetCategories, manualAssets, budgetMonths, flowLabels],
  );

  // Drill-down (plan requirement #3): clicking a band filters the transaction
  // list below to exactly that flow. Only category-backed bands can filter —
  // the synthetic ones ("Left over", "From reserves") are derived totals, not
  // a set of transactions, so selecting them clears instead of filtering to
  // nothing, which would read as "no data" rather than "not applicable".
  const visibleTx = useMemo(() => {
    if (!txFilter) return transactions;
    const { from, to } = monthRange(txFilter.month);
    return transactions.filter(
      (tx) =>
        tx.date >= from &&
        tx.date <= to &&
        (txFilter.categoryId === null ? !tx.categoryId : tx.categoryId === txFilter.categoryId),
    );
  }, [transactions, txFilter]);

  const { income, expenses } = useMemo(() => {
    const now = new Date();
    let inc = 0, exp = 0;
    for (const t of transactions) {
      const d = parseDateLocal(t.date);
      if (d.getMonth() !== now.getMonth() || d.getFullYear() !== now.getFullYear()) continue;
      if (t.type === 'income') inc += t.amount;
      else if (t.type === 'expense') exp += t.amount;
    }
    return { income: inc, expenses: exp };
  }, [transactions]);

  // Heatmap: spend-per-day in base currency. We sum expense transactions
  // and convert to base via cached FX rates. Tinted amber to match the
  // "money awareness" tone used elsewhere (warning, not danger — spending
  // isn't inherently bad, the heatmap just shows when it happened).
  const spendByDay = useMemo(() => {
    const map = new Map<string, number>();
    for (const t of transactions) {
      if (t.type !== 'expense') continue;
      const key = localDateKey(parseDateLocal(t.date));
      // Transactions are already in user's base currency in this store.
      map.set(key, (map.get(key) ?? 0) + t.amount);
    }
    return map;
  }, [transactions]);

  const spendByCategory = useMemo(() => {
    const map = new Map<string, number>();
    const now = new Date();
    for (const t of transactions) {
      if (t.type !== 'expense' || !t.categoryId) continue;
      const d = parseDateLocal(t.date);
      if (d.getMonth() !== now.getMonth() || d.getFullYear() !== now.getFullYear()) continue;
      map.set(t.categoryId, (map.get(t.categoryId) ?? 0) + t.amount);
    }
    return map;
  }, [transactions]);

  return (
    <>
      <AppHeader
        title={t('fin.finance')}
        action={
          // v1.3 BUG-18 — the former News / Insights / Savings / Portfolio
          // chips moved into the segmented views as labelled entry cards,
          // leaving "+ Add" as the single primary action in the header.
          <IconChip emoji="+" label={t('fin.ov.addTransaction')} accent onClick={() => navigate('/finance/add')} />
        }
      />
      {/* v1.9 Item 14 — desktop arrangement. The tab bodies below are flat
          fragments of sibling cards, so they tile straight into this grid at
          `desktop:` with no change to any card. Below 1201px it stays the
          single `space-y-3` stack it has always been. */}
      <div className="space-y-3 desktop:space-y-0 desk-grid">
        {/* Segmented control — the sliding fill plus its 2px index mark
            mirrors the BottomTabBar's language so the two feel like one
            system.
            Spans both columns and keeps a phone-ish width: it switches the
            whole screen, and a 1680px-wide three-segment pill would read as a
            banner rather than a control. */}
        <div className="panel-2 p-1 flex relative desk-span desktop:max-w-lg">
          <span
            aria-hidden
            className="absolute top-1 bottom-1 start-1 rounded-sm transition-transform duration-300 ease-spring-soft"
            style={{
              width: 'calc((100% - 0.5rem) / 3)',
              // --dir is 1 in LTR and -1 in RTL (set in index.css). translateX has no
              // logical form, so without this the pill slides away from the
              // active tab once the axis flips.
              transform: `translateX(calc(var(--dir) * ${FINANCE_TABS.indexOf(tab) * 100}%))`,
              background: 'var(--panel)',
              boxShadow: 'inset 0 -2px 0 var(--signal)',
            }}
          />
          {FINANCE_TABS.map((tb) => (
            <button
              key={tb}
              type="button"
              onClick={() => setTab(tb)}
              aria-current={tab === tb ? 'true' : undefined}
              className={`relative z-10 flex-1 py-2 rounded-sm font-mono text-[0.6875rem] font-medium uppercase tracking-[0.14em] transition-colors duration-200 ${
                tab === tb ? 'text-text' : 'text-text-muted'
              }`}
            >
              {tb === 'balance' ? t('fin.ov.balance') : tb === 'portfolio' ? t('fin.ov.portfolio') : t('fin.ov.markets')}
            </button>
          ))}
        </div>

        {tab === 'balance' && (
          <>
            <div className="grid grid-cols-2 gap-2">
              {/* Neither figure is highlighted: income and expenses are a
                  pair, and marking one of them live said the other was not
                  being reported, which is not what the screen means. */}
              <StatCard value={formatCurrency(income, baseCurrency)} label={t('fin.ov.income')} />
              <StatCard
                value={formatCurrency(expenses, baseCurrency)}
                label={t('fin.ov.expenses')}
                sub={income > 0 ? t('fin.ov.pctOfIncome', { pct: Math.round((expenses / income) * 100) }) : undefined}
                tone={expenses > income ? 'danger' : 'default'}
              />
            </div>

            {/* Net worth — combines portfolio + manual assets - liabilities */}
            <button
              onClick={() => navigate('/finance/networth')}
              className="card text-start w-full active:bg-surface2/40"
            >
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-[0.625rem] uppercase tracking-[0.15em] text-text-muted">
                    {t('fin.ov.netWorth')}
                  </div>
                  <div className={`font-heading font-bold text-xl ${netWorth.total >= 0 ? 'text-text' : 'text-danger'}`}>
                    {netWorth.hasData
                      ? new Intl.NumberFormat(formatLocale(), {
                          style: 'currency',
                          currency: baseCurrency,
                          maximumFractionDigits: 0,
                        }).format(netWorth.total)
                      : '—'}
                  </div>
                </div>
                <span className="chip-micro">
                  {t('fin.ov.manage')}
                </span>
              </div>
              <div className="text-[0.625rem] text-text-muted mt-1">
                {netWorth.hasData
                  ? t('fin.ov.netWorthSub')
                  : t('fin.ov.netWorthEmpty')}
              </div>
            </button>

            <EntryCard
              icon="goals"
              title={t('fin.ov.savingsBuffer')}
              sub={t('fin.ov.savingsSub')}
              onClick={() => navigate('/finance/savings')}
            />

            {/* v1.19 — NCC#202 recurring rules. */}
            <EntryCard
              icon="refresh"
              title={t('recurring.entryTitle')}
              sub={t('recurring.entrySub')}
              onClick={() => navigate('/finance/recurring')}
            />

            {/* What-If — BUG-18 asked for this entry to stand out from the
                rows above it. It did that with a cyan tinted frame; it does it
                now with the lighter panel fill, which is the flat system's way
                of saying "one step forward" without spending the accent on a
                navigation row. */}
            <button
              onClick={() => navigate('/finance/whatif')}
              className="panel-2 p-3 w-full text-start press-spring flex items-center justify-between"
            >
              <div>
                <div className="font-heading font-semibold text-sm text-text">{t('fin.ov.runScenario')}</div>
                <div className="text-[0.6875rem] text-text-muted">{t('fin.ov.runScenarioSub')}</div>
              </div>
              <span className="text-text-muted text-lg rtl-mirror" aria-hidden>→</span>
            </button>

            {/* v1.4 — projected income vs expenses from detected recurring
                patterns. Sits above Budget Breakdown: forward-looking forecast
                first, then the current-month category breakdown. */}
            <CashFlowForecastCard />

            <div className="card">
              <div className="flex items-center justify-between mb-3">
                <span className="font-heading font-semibold text-sm">{t('fin.ov.budgetBreakdown')}</span>
                <button
                  onClick={() => navigate('/finance/budgets')}
                  className="chip-micro press-spring"
                >
                  {t('fin.ov.manage')}
                </button>
              </div>
              <div className="space-y-3">
                {budgetCategories.length === 0 && (
                  <div className="text-xs text-text-muted text-center py-3">
                    {t('fin.ov.budgetEmpty')}
                  </div>
                )}
                {budgetCategories.map((c) => (
                  <ProgressBar
                    key={c.id}
                    label={`${c.icon ? c.icon + ' ' : ''}${c.name}`}
                    value={spendByCategory.get(c.id) ?? 0}
                    max={c.monthlyLimit}
                    format={(v, m) => `${formatCurrency(v, baseCurrency)} / ${formatCurrency(m, baseCurrency)}`}
                  />
                ))}
              </div>
            </div>

            {/* v1.9 Item 14b #4 — CSV import/export. Not desktop-gated: the
                mapping UI wants width and says so, but a phone can still take
                a file and the export path is useful everywhere. */}
            <EntryCard
              icon="file"
              title={t('fin.imp.entryTitle')}
              sub={t('fin.imp.entrySub')}
              onClick={() => navigate('/finance/import')}
            />

            {transactions.length > 0 && (
              <div className="card">
                <div className="flex items-center justify-between mb-2">
                  <span className="font-heading font-semibold text-sm">{t('fin.ov.spendPattern')}</span>
                  <span className="text-[0.5625rem] uppercase tracking-wider text-text-muted">
                    {t('fin.ov.spendDays', { cur: baseCurrency })}
                  </span>
                </div>
                <HeatmapCalendar data={spendByDay} tint="warning" unit={baseCurrency === 'EUR' ? '€' : baseCurrency} />
                {spendByDay.size === 0 && (
                  <div className="text-[0.625rem] text-text-muted mt-2 text-center">
                    {t('fin.ov.spendEmpty')}
                  </div>
                )}
              </div>
            )}

            {/* v1.9 Item 14b #2 — spans the full grid: a Sankey needs width to
                be readable, and halving it would defeat the point. Desktop
                only; the phone keeps the stat cards above as its summary. */}
            {isDesktop && (
              <div className="desk-span">
                <CashFlowDiagram
                  model={cashFlow}
                  baseCurrency={baseCurrency}
                  onSelect={(node) =>
                    setTxFilter((cur) =>
                      // Synthetic nodes are derived totals with no transaction
                      // set behind them, so they clear rather than filter to an
                      // empty list that would read as "no data".
                      !node.categoryId ||
                      (cur?.categoryId === node.categoryId && cur.month === currentMonthKey)
                        ? null
                        : { categoryId: node.categoryId, month: currentMonthKey, label: node.label },
                    )
                  }
                />
              </div>
            )}

            {/* v1.9 Item 14b #6 — budget vs actual. Full grid width beside the
                cash-flow diagram: the two answer "where did it go" and "versus
                what you planned" off one aggregation, so they belong together
                and both need the horizontal room. */}
            {isDesktop && (
              <div className="desk-span card">
                <div className="flex items-center justify-between gap-2 mb-3 flex-wrap">
                  <span className="font-heading font-semibold text-sm">{t('fin.bvt.title')}</span>
                  <div className="flex items-center gap-1.5">
                    {[3, 6, 12].map((m) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => setBudgetMonths(m)}
                        className={`text-[0.625rem] uppercase tracking-wider px-1.5 py-0.5 rounded-sm border ${
                          budgetMonths === m
                            ? 'border-primary/40 bg-primary/5 text-primary'
                            : 'border-border text-text-muted'
                        }`}
                      >
                        {t('fin.nwt.months', { count: m })}
                      </button>
                    ))}
                    <button
                      type="button"
                      onClick={() => navigate('/finance/budgets')}
                      className="chip-micro press-spring"
                    >
                      {t('fin.ov.manage')}
                    </button>
                  </div>
                </div>
                <BudgetTrendTable
                  trend={budgetTrend}
                  baseCurrency={baseCurrency}
                  formatCurrency={(v, c) => formatMoney(v, c, { locale: formatLocale() })}
                  selected={txFilter}
                  onSelect={(categoryId, month, label) =>
                    setTxFilter((cur) =>
                      cur?.categoryId === categoryId && cur.month === month
                        ? null
                        : { categoryId, month, label },
                    )
                  }
                />
              </div>
            )}

            <div className="card">
              <div className="flex items-center justify-between mb-3">
                <span className="font-heading font-semibold text-sm">{t('fin.ov.recentTx')}</span>
                <span className="text-[0.5625rem] uppercase tracking-wider text-text-muted">
                  {t('fin.ov.txTotal', { count: visibleTx.length })}
                </span>
              </div>
              {txFilter && (
                <button
                  type="button"
                  onClick={() => setTxFilter(null)}
                  className="mb-2 inline-flex items-center gap-1.5 rounded-sm border border-primary/40 bg-primary/10 px-2.5 py-1 text-[0.6875rem] text-primary"
                >
                  {txFilter.label}
                  <span className="text-primary/70">{txFilter.month}</span>
                  <span aria-hidden>&times;</span>
                </button>
              )}
              <div className="space-y-1">
                {visibleTx.slice(0, 12).map((tx) => (
                  <div key={tx.id} className="flex items-center gap-2 py-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-text-faint flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm truncate">{tx.description}</div>
                      <div className="text-[0.625rem] text-text-muted">{formatShortDate(tx.date)}</div>
                    </div>
                    <span
                      className={`text-sm whitespace-nowrap ${
                        tx.type === 'income' ? 'text-success' : 'text-text-muted'
                      }`}
                    >
                      {tx.type === 'income' ? '+' : '–'}
                      {formatCurrency(tx.amount, baseCurrency)}
                    </span>
                    <RowActions
                      onEdit={() => navigate(`/finance/add?id=${tx.id}`)}
                      onDelete={() => deleteTransaction(tx.id)}
                      confirmMsg={t('fin.ov.deleteConfirm', { name: tx.description })}
                    />
                  </div>
                ))}
                {transactions.length === 0 && (
                  <div className="text-xs text-text-muted text-center py-4">{t('fin.ov.noTx')}</div>
                )}
              </div>
            </div>
          </>
        )}

        {tab === 'portfolio' && (
          <>
            <EntryCard
              icon="holdings"
              title={t('fin.ov.holdings')}
              sub={
                holdings.length > 0
                  ? t('fin.ov.holdingsPositions', { count: holdings.length })
                  : t('fin.ov.holdingsEmpty')
              }
              onClick={() => navigate('/finance/portfolio')}
            />
            <EntryCard
              icon="watch"
              title={t('fin.ov.watchlist')}
              sub={t('fin.ov.watchlistSub')}
              onClick={() => navigate('/finance/portfolio/watchlist')}
            />
            <EntryCard
              icon="inflation"
              title={t('fin.ov.insights')}
              sub={t('fin.ov.insightsSub')}
              onClick={() => navigate('/finance/insights')}
            />

            {/* Market news — the standalone /finance/news screen was retired
                in the v1.3 scope reduction (BUG-17); this card is now its
                home, sitting with the rest of the market surface. */}
            <NewsCard />
          </>
        )}

        {tab === 'markets' && <MarketsSegment />}
      </div>
    </>
  );
}

/**
 * v1.2 follow-up — compact icon-only header chip. 32×32 square, panel-2
 * background by default, accent variant for the primary "+ Add" action.
 * Emoji is centered (not text) so we stay flexible to whatever the user's
 * font fallback renders. aria-label carries the semantic name for screen
 * readers and long-press accessibility tooltips.
 */
function IconChip({ emoji, label, onClick, accent }: {
  emoji: string; label: string; onClick: () => void; accent?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      // `accent` now separates the primary header action from its siblings by
      // ink weight alone. It used to add a cyan wash, which made a small square
      // button the brightest thing in a header that also carries the screen
      // title.
      className={`w-8 h-8 rounded-sm flex items-center justify-center text-sm press-spring panel-2 ${
        accent ? 'text-text' : 'text-text-muted active:text-text'
      }`}
    >
      <span aria-hidden>{emoji}</span>
    </button>
  );
}

/**
 * v1.3 BUG-18 — labelled navigation row used inside the Balance + Portfolio
 * segments. Panel, icon + title + sub on the left, a chevron on the right.
 * Replaces the cramped icon-only header chips with something that actually
 * says where it goes.
 */
function EntryCard({ icon, title, sub, onClick }: {
  icon: string; title: string; sub: string; onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="card w-full text-start flex items-center gap-3 active:bg-surface2/40 press-spring"
    >
      <Glyph name={icon} size={17} className="text-text-muted" />
      <div className="flex-1 min-w-0">
        <div className="font-heading font-semibold text-sm">{title}</div>
        <div className="text-[0.6875rem] text-text-muted truncate">{sub}</div>
      </div>
      <span className="text-text-muted text-sm rtl-mirror" aria-hidden>→</span>
    </button>
  );
}
