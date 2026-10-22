// Net worth = portfolio value + manual assets - manual liabilities.
//
// Portfolio side reuses everything the Portfolio screen computes (totals,
// FX conversion). Manual assets/liabilities are a flat list the user
// maintains here.
//
// v1.2 follow-up — BUG-5. The Savings Buffer card on top no longer derives
// runway from TOTAL liquid cash divided by monthly expenses. Instead, it
// reads the user's pinned Emergency Buffer goal from the SavingsGoals store
// — runway = bufferGoal.allocatedAmount / monthlyExpensesAvg. This way the
// number reflects what's actually reserved as buffer rather than treating
// every cash dollar as if it's earmarked for the emergency fund. Adjust the
// reserve on the Savings screen; this card mirrors it.

import { useMemo, useState } from 'react';
import { currencyOptions, formatMoney } from '../../lib/currencies';
import { formatLocale, localDateKey } from '../../utils/formatters';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import AppHeader from '../../components/AppHeader';
import RowActions from '../../components/RowActions';
import { useFinanceStore } from '../../store/useFinanceStore';
import { useSettingsStore } from '../../store/useSettingsStore';
import { convertSync } from '../../api/fxRates';
import type { ManualAsset, ManualAssetType } from '../../types/finance';
import { LIABILITY_TYPES } from '../../types/finance';
// v1.2 follow-up — CTO Account refactor. Account balances derive from the
// transactions slice; the helper handles FX + transfer-in/out + sign
// conventions for liability accounts.
import { computeAccountBalance } from '../../lib/accountBalance';
import { portfolioCashBalance } from '../../lib/portfolioCash';
// v1.9 Item 14b #5 — the time-series the Account model never got.
import { buildNetWorthTrend } from '../../lib/netWorthTrend';
import NetWorthTrendChart, { NetWorthBreakdown } from '../../components/NetWorthTrendChart';
import { useShellTier } from '../../lib/useShell';
import Glyph from '../../components/Glyph';
// v1.18.1 (NCC#144): typed amounts accept a decimal comma.
import { numberInput } from '@/lib/numberInput';



function fmt(amount: number, currency: string): string {
  return formatMoney(amount, currency, { locale: formatLocale() });
}

// v1.2 follow-up — CTO Account refactor. Map covers the full AccountType
// union now (checking + investment + custom added; legacy 'credit' renamed
// to 'credit_card'). Net Worth keeps using this for the inline asset
// editor — the full Account-aware UI lands in the dedicated AccountDetail
// refactor pass.
const ASSET_META: Record<ManualAssetType, { icon: string; label: string }> = {
  // `icon` is a Glyph name (components/Glyph.tsx), not a character. This map
  // is keyed by account type and never persisted, so it takes clean names.
  checking: { icon: 'bank', label: 'Checking' },
  savings: { icon: 'savings', label: 'Savings' },
  cash: { icon: 'cash', label: 'Cash' },
  credit_card: { icon: 'card', label: 'Credit Card' },
  investment: { icon: 'investment', label: 'Investment' },
  property: { icon: 'property', label: 'Property' },
  vehicle: { icon: 'vehicle', label: 'Vehicle' },
  loan: { icon: 'loan', label: 'Loan' },
  other: { icon: 'other', label: 'Other' },
  custom: { icon: 'custom', label: 'Custom' },
};

// Cash-ish account types that count toward the "Liquid" breakdown cell.
// `checking` joins cash + savings now that the Account model has it. The
// runway-card math uses `savings` only (per CTO spec — savings account
// balance is the buffer source of truth).
const LIQUID_TYPES: ManualAssetType[] = ['cash', 'savings', 'checking'];

export default function NetWorth() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const baseCurrency = useSettingsStore((s) => s.baseCurrency);
  const manualAssets = useFinanceStore((s) => s.manualAssets);
  const addAsset = useFinanceStore((s) => s.addManualAsset);
  const updateAsset = useFinanceStore((s) => s.updateManualAsset);
  const deleteAsset = useFinanceStore((s) => s.deleteManualAsset);
  const transactions = useFinanceStore((s) => s.transactions);
  const fxRates = useFinanceStore((s) => s.fxRates);
  // Portfolio value uses the same totals math the Portfolio screen does, but
  // we recompute here so this screen doesn't depend on Portfolio having been
  // visited. Cheaper than threading state. Falls back to 0 when quotes
  // haven't loaded yet.
  const portfolioValueBase = usePortfolioValueBase(baseCurrency);
  // v1.3.2 — portfolio cash is part of the portfolio's net-worth contribution.
  const cashEntries = useFinanceStore((s) => s.portfolioCashEntries);
  const portfolioCashBase = useMemo(
    () => portfolioCashBalance(cashEntries, baseCurrency, fxRates),
    [cashEntries, baseCurrency, fxRates],
  );
  // Holdings market value + uninvested cash = the portfolio side of net worth.
  const portfolioTotalBase = portfolioValueBase + portfolioCashBase;

  const [editing, setEditing] = useState<ManualAsset | null>(null);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [assetType, setAssetType] = useState<ManualAssetType>('cash');
  const [value, setValue] = useState('');
  const [currency, setCurrency] = useState('EUR');
  const [notes, setNotes] = useState('');

  // v1.2 follow-up — CTO Account refactor. Each ManualAsset row is now an
  // Account; the displayed balance is DERIVED via
  // `computeAccountBalance(account, transactions, fxRates, baseCurrency)`
  // instead of the historical "static balance the user edits manually".
  // Below we annotate each row with its derived balance in two forms:
  //   - `balanceNative`: in the account's own currency (rendered on the row)
  //   - `base`: signed contribution to net worth (negative for liability
  //     accounts because their balance is already negative-by-convention)
  // The legacy LIABILITY_TYPES.includes(...) gating is gone — liability
  // accounts contribute via their natural negative balance, not via a
  // separate "totalLiabilities" subtraction.
  const inBase = useMemo(() => {
    return manualAssets.map((a) => {
      const result = computeAccountBalance(a, transactions, fxRates, baseCurrency);
      const balanceNative = result.balance;
      const base = a.currency === baseCurrency
        ? balanceNative
        : convertSync(balanceNative, a.currency, baseCurrency, fxRates);
      return { ...a, balanceNative, base: base ?? null };
    });
  }, [manualAssets, transactions, fxRates, baseCurrency]);

  // Assets + Liabilities split for the headline pills (cosmetic — total
  // net worth = sum of all base balances and is the source of truth).
  const totalAssets = useMemo(
    () =>
      inBase
        .filter((a) => !LIABILITY_TYPES.includes(a.accountType))
        .reduce((acc, a) => acc + (a.base ?? 0), 0),
    [inBase],
  );
  const totalLiabilities = useMemo(
    () =>
      // Liability accounts carry a negative balance — flip the sign here so
      // the "Liabilities" pill reads as a positive amount owed.
      inBase
        .filter((a) => LIABILITY_TYPES.includes(a.accountType))
        .reduce((acc, a) => acc - (a.base ?? 0), 0),
    [inBase],
  );

  const netWorth = portfolioTotalBase + totalAssets - totalLiabilities;

  // ─── v1.9 Item 14b #5 — trended net worth ───────────────────────────────
  //
  // Window and display currency are VIEW state: the currency toggle restates
  // the chart without touching the user's base-currency setting, which is a
  // preference, not a lens. The trend itself is always built in base currency
  // and scaled at render — conversion is linear, so one rate lookup restates
  // every figure consistently instead of converting account by account.
  const tier = useShellTier();
  const snapshots = useFinanceStore((s) => s.portfolioSnapshots);
  const [trendMonths, setTrendMonths] = useState(12);
  // `string`, not the currency union: the <select> hands back a plain string
  // and the trend builder takes any code the FX table can resolve.
  const [trendCurrency, setTrendCurrency] = useState<string>(baseCurrency);
  const [selectedMonth, setSelectedMonth] = useState<string | null>(null);

  const trend = useMemo(
    () =>
      buildNetWorthTrend({
        accounts: manualAssets,
        transactions,
        snapshots,
        // Same selector the headline portfolio-cash figure reads, so the trend's
        // last point and the total above it cannot disagree.
        cashEntries,
        fxRates,
        baseCurrency,
        months: trendMonths,
        today: localDateKey(new Date()),
      }),
    [manualAssets, transactions, snapshots, cashEntries, fxRates, baseCurrency, trendMonths],
  );

  // One rate for the whole restatement. null (an unknown rate) falls back to
  // base rather than silently rendering unconverted numbers under a different
  // currency symbol, which would be a straightforwardly wrong chart.
  const trendRate = useMemo(() => {
    if (trendCurrency === baseCurrency) return 1;
    const r = convertSync(1, baseCurrency, trendCurrency, fxRates);
    return r ?? null;
  }, [trendCurrency, baseCurrency, fxRates]);
  const effectiveTrendCurrency = trendRate == null ? baseCurrency : trendCurrency;
  const scale = trendRate ?? 1;

  const scaledTrend = useMemo(() => {
    if (scale === 1) return trend;
    return {
      ...trend,
      points: trend.points.map((p) => ({
        ...p,
        accounts: p.accounts.map((a) => ({ ...a, base: a.base * scale })),
        accountsBase: p.accountsBase * scale,
        holdingsBase: p.holdingsBase == null ? null : p.holdingsBase * scale,
        portfolioCashBase: p.portfolioCashBase * scale,
        total: p.total * scale,
      })),
    };
  }, [trend, scale]);

  const selectedPoint =
    scaledTrend.points.find((p) => p.month === selectedMonth) ??
    scaledTrend.points[scaledTrend.points.length - 1] ??
    null;

  // Savings runway: months of expenses covered by liquid cash/savings.
  // Uses last 90d of expense transactions / 3 for monthly average.
  const monthlyExpensesAvg = useMemo(() => {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 90);
    const cutoffKey = cutoff.toISOString().slice(0, 10);
    let sum = 0;
    for (const t of transactions) {
      if (t.type !== 'expense') continue;
      if (t.date < cutoffKey) continue;
      sum += t.amount;
    }
    return sum / 3;
  }, [transactions]);

  // v1.2 follow-up — CTO Account refactor (BUG-5 partial revert). Per CTO
  // spec: "savings account balance replaces the duplicate savings input on
  // net worth page." Runway is now derived from the sum of Savings-type
  // account balances (FX-converted to base) rather than the legacy buffer
  // goal's allocatedAmount. The Buffer goal still exists for users who
  // want to explicitly earmark a portion of their savings on the Savings
  // Goals screen — it just no longer feeds this card.
  const savingsAccountsBase = useMemo(
    () =>
      inBase
        .filter((a) => a.accountType === 'savings' && !a.archivedAt)
        .reduce((acc, a) => acc + (a.base ?? 0), 0),
    [inBase],
  );
  const liquidBase = useMemo(
    () =>
      inBase
        .filter((a) => LIQUID_TYPES.includes(a.accountType) && !a.archivedAt)
        .reduce((acc, a) => acc + (a.base ?? 0), 0),
    [inBase],
  );
  const runwayMonths = monthlyExpensesAvg > 0 ? savingsAccountsBase / monthlyExpensesAvg : 0;
  // Industry rule of thumb: 3-6 months emergency fund.
  const runwayStatus: 'low' | 'ok' | 'good' =
    runwayMonths < 3 ? 'low' : runwayMonths < 6 ? 'ok' : 'good';

  const startAdd = () => {
    setEditing(null);
    setAdding(true);
    setName('');
    setAssetType('cash');
    setValue('');
    setCurrency(baseCurrency);
    setNotes('');
  };

  const startEdit = (a: ManualAsset & { balanceNative?: number }) => {
    setEditing(a);
    setAdding(false);
    setName(a.name);
    setAssetType(a.accountType);
    // v1.2 follow-up — Account refactor UX fix. The form field shows the
    // CURRENT derived balance (700 in the user's "savings 500 + income 200"
    // example), not the opening figure (500). The user's mental model is
    // "this number should match what I see on the row." On save we back-
    // solve the new startingBalance so the displayed balance ends up
    // equal to what the user typed. Fallback to `a.value` when
    // `balanceNative` is absent (defensive — every inBase row populates it).
    setValue(String(a.balanceNative ?? a.value));
    setCurrency(a.currency);
    setNotes(a.notes ?? '');
  };

  const cancel = () => {
    setEditing(null);
    setAdding(false);
  };

  const save = async () => {
    const n = numberInput(value);
    if (!name.trim() || isNaN(n)) return;
    if (editing) {
      // v1.2 follow-up — Account refactor UX fix. `n` is the desired CURRENT
      // balance (what the user sees in the form). To make
      // computeAccountBalance() resolve to that number, back-solve:
      //   newStartingBalance = desiredCurrent − txnDelta(account)
      // where txnDelta is the sum of every transaction that already touched
      // the account. This way the user's input matches the row display
      // afterwards; the opening figure quietly absorbs the difference.
      const balanceResult = computeAccountBalance(
        editing,
        transactions,
        fxRates,
        baseCurrency,
      );
      const newStartingBalance = n - balanceResult.txnDelta;
      await updateAsset(editing.id, {
        name: name.trim(),
        accountType: assetType,
        startingBalance: newStartingBalance,
        assetType,
        value: newStartingBalance,
        currency,
        notes: notes.trim() || undefined,
      });
    } else {
      // Add mode — no transactions yet, so the input IS the starting balance.
      await addAsset({
        name: name.trim(),
        accountType: assetType,
        startingBalance: n,
        assetType,
        value: n,
        currency,
        notes: notes.trim() || undefined,
      });
    }
    cancel();
  };

  const editingNow = adding || editing != null;
  // v1.2 follow-up — CTO Account refactor. Group from `inBase` so each item
  // carries its derived `balanceNative` field. The row renderer below
  // shows the LIVE balance (startingBalance + transaction deltas) rather
  // than the stored opening figure, so users see numbers that match the
  // transaction history. Archived accounts are filtered here so they don't
  // appear in the primary list.
  const assetGroups = useMemo(() => {
    type Row = ManualAsset & { balanceNative: number; base: number | null };
    const byType: Record<ManualAssetType, Row[]> = {} as Record<ManualAssetType, Row[]>;
    for (const a of inBase) {
      if (a.archivedAt) continue;
      (byType[a.accountType] ??= []).push(a);
    }
    return byType;
  }, [inBase]);

  return (
    <>
      <AppHeader
        title={t('fin.ov.netWorth')}
        back="/finance"
        backLabel={t('fin.finance')}
        showAvatar={false}
        action={
          !editingNow && (
            <>
              <button
                onClick={() => navigate('/finance/whatif')}
                className="text-xs px-2 py-1 rounded-sm border border-border text-text-muted active:text-text active:border-border"
              >
                {t('fin.nw.whatIf')}
              </button>
              <button
                onClick={startAdd}
                className="chip press-spring"
              >
                {t('fin.nw.addAsset')}
              </button>
            </>
          )
        }
      />
      <div className="space-y-3">
        {/* Total */}
        <div className="card-elevated">
          <div className="text-[0.625rem] uppercase tracking-[0.15em] text-text-muted mb-1">
            {t('fin.nw.totalNetWorth')}
          </div>
          <div className={`font-heading font-bold text-3xl tracking-tight ${netWorth >= 0 ? 'text-text' : 'text-danger'}`}>
            {fmt(netWorth, baseCurrency)}
          </div>
          <div className="grid grid-cols-3 gap-2 mt-3 pt-3 border-t border-border/40">
            <Cell label={t('fin.ov.portfolio')} value={fmt(portfolioTotalBase, baseCurrency)} />
            <Cell label={t('fin.nw.otherAssets')} value={fmt(totalAssets, baseCurrency)} />
            <Cell label={t('fin.nw.liabilities')} value={`−${fmt(totalLiabilities, baseCurrency)}`} tone={totalLiabilities > 0 ? 'danger' : 'default'} />
          </div>
        </div>

        {/* v1.9 Item 14b #5 — trended net worth. Chart and breakdown sit side
            by side at desktop (the breakdown is the answer to a question the
            chart raises, so they belong in one glance) and stack below it
            elsewhere. */}
        {!scaledTrend.isEmpty && (
          <div className="card">
            <div className="flex items-center justify-between gap-2 mb-2 flex-wrap">
              <span className="font-heading font-semibold text-sm">{t('fin.nwt.title')}</span>
              <div className="flex items-center gap-1.5">
                {[6, 12, 24].map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setTrendMonths(m)}
                    className={`text-[0.625rem] uppercase tracking-wider px-1.5 py-0.5 rounded-sm border ${
                      trendMonths === m
                        ? 'border-primary/40 bg-primary/5 text-primary'
                        : 'border-border text-text-muted'
                    }`}
                  >
                    {t('fin.nwt.months', { count: m })}
                  </button>
                ))}
                <select
                  aria-label={t('fin.nwt.currency')}
                  value={effectiveTrendCurrency}
                  onChange={(e) => setTrendCurrency(e.target.value)}
                  className="text-[0.625rem] uppercase tracking-wider bg-surface2 border border-border rounded-sm px-1.5 py-0.5 text-text-muted focus:outline-none focus:border-primary"
                >
                  {currencyOptions(formatLocale()).map((c) => (
                    <option key={c.code} value={c.code}>
                      {c.code}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="grid gap-4 desktop:grid-cols-[1.6fr_1fr] items-start">
              <NetWorthTrendChart
                trend={scaledTrend}
                currency={effectiveTrendCurrency}
                formatCurrency={fmt}
                formatCompact={(v) =>
                  new Intl.NumberFormat(formatLocale(), {
                    notation: 'compact',
                    maximumFractionDigits: 1,
                  }).format(v)
                }
                selected={selectedMonth}
                onSelect={setSelectedMonth}
              />
              {selectedPoint && (
                <div className={tier === 'desktop' ? '' : 'pt-3 border-t border-border/40'}>
                  <NetWorthBreakdown
                    point={selectedPoint}
                    currency={effectiveTrendCurrency}
                    formatCurrency={fmt}
                    typeLabel={(k) => ASSET_META[k as ManualAssetType]?.label ?? k}
                  />
                </div>
              )}
            </div>

            {/* Both caveats are properties of the data, not of the chart, so
                they are stated rather than designed around. */}
            <div className="mt-2 space-y-0.5">
              {trendRate == null && trendCurrency !== baseCurrency && (
                <div className="text-[0.625rem] text-warning">
                  {t('fin.nwt.noRate', { currency: trendCurrency })}
                </div>
              )}
              {scaledTrend.usedFx && (
                <div className="text-[0.625rem] text-text-muted">{t('fin.nwt.fxCaveat')}</div>
              )}
              <div className="text-[0.625rem] text-text-muted">{t('fin.nwt.historyCaveat')}</div>
            </div>
          </div>
        )}

        {/* v1.2 follow-up — CTO Account refactor (BUG-5 partial revert).
            Savings Buffer card reads the SUM of all Savings-type account
            balances per CTO spec ("savings account balance replaces the
            duplicate savings input on net worth page"). The Buffer goal
            in Savings Goals is preserved for users who want explicit
            earmarking within their savings — but THIS card now reflects
            the actual cash sitting in savings accounts, not a separate
            buffer figure. Tap → /finance/savings to manage goals + see
            the Emergency Buffer goal if pinned. */}
        <button
          type="button"
          onClick={() => navigate('/finance/savings')}
          className="card w-full text-start press-spring"
        >
          <div className="flex items-center justify-between mb-2">
            <span className="font-heading font-semibold text-sm">{t('fin.nw.savingsRunway')}</span>
            <span className={`text-[0.5625rem] uppercase tracking-wider border rounded-sm px-1.5 py-0.5 ${
              savingsAccountsBase <= 0
                ? 'border-text-muted/40 bg-surface2 text-text-muted'
                : runwayStatus === 'good'
                  ? 'border-success/40 bg-success/5 text-success'
                  : runwayStatus === 'ok'
                    ? 'border-warning/40 bg-warning/5 text-warning'
                    : 'border-danger/40 bg-danger/5 text-danger'
            }`}>
              {savingsAccountsBase <= 0
                ? t('fin.nw.noSavings')
                : runwayStatus === 'good' ? t('fin.nw.strong') : runwayStatus === 'ok' ? t('fin.nw.ok') : t('fin.nw.low')}
            </span>
          </div>
          <div className="flex items-baseline justify-between mb-1">
            <span className="font-heading font-bold text-xl tracking-tight">
              {runwayMonths > 0 && isFinite(runwayMonths)
                ? t('fin.nw.months', { n: runwayMonths.toFixed(1) })
                : '—'}
            </span>
            <span className="text-xs text-text-muted">
              {t('fin.nw.ofExpenses')}
            </span>
          </div>
          <div className="text-[0.625rem] text-text-muted">
            {savingsAccountsBase > 0
              ? t('fin.nw.runwayDesc', { sav: fmt(savingsAccountsBase, baseCurrency), exp: fmt(monthlyExpensesAvg, baseCurrency) })
              : t('fin.nw.runwayEmpty', { liq: fmt(liquidBase, baseCurrency) })}
          </div>
        </button>

        {/* Add/edit form */}
        {editingNow && (
          <div className="card space-y-2">
            <div className="font-heading font-semibold text-sm">
              {editing ? t('fin.nw.editAccount') : t('fin.nw.newAccount')}
            </div>
            <div className="grid grid-cols-4 gap-2">
              {(Object.keys(ASSET_META) as ManualAssetType[]).map((ty) => (
                <button
                  key={ty}
                  type="button"
                  onClick={() => setAssetType(ty)}
                  className={`chip flex-col gap-0.5 py-2 ${assetType === ty ? 'chip-on' : ''}`}
                >
                  <Glyph name={ASSET_META[ty].icon} size={15} />
                  <span className="text-[0.5625rem] uppercase tracking-wider">{t(`fin.acctType.${ty}`)}</span>
                </button>
              ))}
            </div>
            <input
              className="input"
              placeholder={t('fin.nw.namePh')}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            {/* v1.2 follow-up — Account refactor UX fix. The label flips
                between "Current balance" (editing — what the user sees on
                the row) and "Starting balance" (add — opening figure for a
                fresh account). For edit mode we ALSO show the opening
                figure read-only so the user can see how the number
                will resolve. */}
            <div>
              <div className="sec mb-1">
                {editing ? t('fin.nw.currentBalance') : t('fin.nw.startingBalance')}
              </div>
              <div className="flex gap-2">
                <input
                  className="input flex-1"
                  placeholder={editing ? t('fin.nw.currentBalance') : t('fin.nw.startingBalance')}
                  inputMode="decimal"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                />
                <select
                  className="input max-w-[88px]"
                  value={currency}
                  onChange={(e) => setCurrency(e.target.value)}
                >
                  {currencyOptions(formatLocale()).map((c) => (
                    <option key={c.code} value={c.code}>{c.label}</option>
                  ))}
                </select>
              </div>
              {editing && (
                <div className="text-[0.625rem] text-text-muted mt-1">
                  {t('fin.nw.openingNote', { amt: fmt(editing.startingBalance, editing.currency) })}
                </div>
              )}
            </div>
            <input
              className="input"
              placeholder={t('fin.nw.notesPh')}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
            <div className="flex gap-2">
              <button className="btn flex-1" onClick={save}>
                {editing ? t('common.save') : t('common.add')}
              </button>
              <button className="btn-ghost flex-1" onClick={cancel}>
                {t('common.cancel')}
              </button>
            </div>
            <div className="text-[0.625rem] text-text-muted">
              {LIABILITY_TYPES.includes(assetType)
                ? t('fin.nw.liabilityHint')
                : t('fin.nw.assetHint')}
            </div>
          </div>
        )}

        {/* Account list by type. v1.2 follow-up — CTO Account refactor.
            Per-row balance is now DERIVED (`a.balanceNative` from
            `computeAccountBalance`) rather than the stored opening figure
            `a.value`. Row body is tappable → `/finance/account/:id` for
            the AccountDetail running-balance + transaction-history screen. */}
        {(Object.keys(ASSET_META) as ManualAssetType[]).map((type) => {
          const items = assetGroups[type] ?? [];
          if (items.length === 0) return null;
          const meta = ASSET_META[type];
          const isLiability = LIABILITY_TYPES.includes(type);
          const groupTotal = items.reduce(
            (acc, a) => acc + Math.abs(a.base ?? 0),
            0,
          );
          return (
            <div key={type} className="card">
              <div className="flex items-center justify-between mb-2">
                <span className="font-heading font-semibold text-sm">
                  <Glyph name={meta.icon} size={14} className="text-text-muted inline-block align-[-2px] me-1.5" />
                  {t(`fin.acctType.${type}`)}
                </span>
                <span className={`text-xs ${isLiability ? 'text-danger' : 'text-text-muted'}`}>
                  {isLiability ? '−' : ''}{fmt(groupTotal, baseCurrency)}
                </span>
              </div>
              {items.map((a) => (
                <div key={a.id} className="flex items-center gap-2 py-2 border-b border-border/40 last:border-0">
                  <button
                    type="button"
                    onClick={() => navigate(`/finance/account/${a.id}`)}
                    className="flex-1 min-w-0 text-start press-spring"
                  >
                    <div className="text-sm font-medium truncate">{a.name}</div>
                    <div className="text-[0.625rem] text-text-muted truncate">
                      {fmt(a.balanceNative, a.currency)} · {t('fin.ad.opened').toLowerCase()} {fmt(a.startingBalance, a.currency)}
                      {a.notes && ` · ${a.notes}`}
                    </div>
                  </button>
                  <RowActions
                    onEdit={() => startEdit(a)}
                    onDelete={() => deleteAsset(a.id)}
                    confirmMsg={t('fin.nw.removeConfirm', { name: a.name })}
                  />
                </div>
              ))}
            </div>
          );
        })}

        {manualAssets.length === 0 && !editingNow && (
          <div className="card">
            <div className="text-xs text-text-muted text-center py-3">
              {t('fin.nw.empty')}
            </div>
          </div>
        )}
      </div>
    </>
  );
}

function Cell({ label, value, tone }: { label: string; value: string; tone?: 'default' | 'danger' }) {
  return (
    <div>
      <div className="text-[0.5625rem] uppercase tracking-wider text-text-muted">{label}</div>
      <div className={`text-sm font-medium ${tone === 'danger' ? 'text-danger' : ''}`}>{value}</div>
    </div>
  );
}

// Lightweight hook: derives portfolio value in base currency from the same
// store state Portfolio.tsx uses. Doesn't trigger any new fetches — just
// reads what's already loaded.
function usePortfolioValueBase(baseCurrency: string): number {
  const holdings = useFinanceStore((s) => s.holdings);
  const stockQuotes = useFinanceStore((s) => s.stockQuotes);
  const cryptoPrices = useFinanceStore((s) => s.cryptoPrices);
  const fxRates = useFinanceStore((s) => s.fxRates);
  return useMemo(() => {
    let total = 0;
    for (const h of holdings) {
      if (h.assetType === 'stock' || h.assetType === 'etf') {
        const q = stockQuotes.find((s) => s.ticker === h.ticker);
        if (!q) continue;
        const native = q.quote.c * h.quantity;
        const conv = convertSync(native, q.currency, baseCurrency, fxRates);
        if (conv != null) total += conv;
      } else {
        const p = cryptoPrices?.prices.find((p) => p.id === h.ticker);
        if (!p) continue;
        const nativeEur = p.priceEur * h.quantity;
        const conv = baseCurrency === 'EUR' ? nativeEur : convertSync(nativeEur, 'EUR', baseCurrency, fxRates);
        if (conv != null) total += conv;
      }
    }
    return total;
  }, [holdings, stockQuotes, cryptoPrices, fxRates, baseCurrency]);
}
