// "What-If" simulator. Project net worth forward with adjustable monthly
// contributions, time horizon, and two return-rate scenarios shown
// side-by-side.
//
// Design choices made explicit in the UI:
//   - TWO scenarios always shown together (conservative vs optimistic).
//     Single-scenario FIRE projections look certain in a way reality isn't.
//     The shaded band between them is the "honest uncertainty" range.
//   - Inflation toggle: nominal balance is the default (matches your bank
//     statement) but "in today's money" is the more useful long-horizon
//     view. Both are computed; the user picks which axis to read.
//   - Starting balance defaults to current net worth — portfolio + manual
//     assets - liabilities — so the projection starts from the user's
//     actual position, not zero.

import { useEffect, useMemo, useRef, useState } from 'react';
import { formatLocale } from '../../utils/formatters';
import { useTranslation } from 'react-i18next';
import AppHeader from '../../components/AppHeader';
import { useFinanceStore } from '../../store/useFinanceStore';
import { useSettingsStore } from '../../store/useSettingsStore';
import { convertSync, normalizeCurrency } from '../../api/fxRates';
import { LIABILITY_TYPES } from '../../types/finance';
import { project, yearReachingMilestone } from '../../lib/projection';
import { RULE, INK_MUTE, SUCCESS } from '../../lib/themeColors';
// v1.18.1 (NCC#166): typed amounts and rates accept a decimal comma.
import { numberInput } from '@/lib/numberInput';

// Milestones are derived from the user's current net worth rather than fixed,
// because a fixed euro ladder is meaningless at other currency scales. In IDR
// 1,000,000 is roughly €60, so every rung was already passed and the whole
// feature rendered as noise; in INR the spacing was wrong for the opposite
// reason. Powers of ten above the starting balance, at 1x/2.5x/5x within each
// decade, give the same "next few meaningful targets" shape at any scale.
function milestonesFor(startingBalance: number): number[] {
  const base = Math.max(1000, Math.abs(startingBalance));
  const decade = Math.pow(10, Math.floor(Math.log10(base)));
  const out: number[] = [];
  for (let d = decade; out.length < 6; d *= 10) {
    for (const mult of [1, 2.5, 5]) {
      const v = Math.round(d * mult);
      if (v > base && out.length < 6) out.push(v);
    }
  }
  return out;
}

const CONSERVATIVE_DEFAULT = 4;
const OPTIMISTIC_DEFAULT = 7;
const INFLATION_DEFAULT = 2.5;

export default function WhatIf() {
  const { t } = useTranslation();
  const holdings = useFinanceStore((s) => s.holdings);
  const stockQuotes = useFinanceStore((s) => s.stockQuotes);
  const cryptoPrices = useFinanceStore((s) => s.cryptoPrices);
  const fxRates = useFinanceStore((s) => s.fxRates);
  const manualAssets = useFinanceStore((s) => s.manualAssets);
  const baseCurrency = useSettingsStore((s) => s.baseCurrency);

  // Compute current net worth — same formula as NetWorth.tsx & FinanceOverview.
  const currentNetWorth = useMemo(() => {
    let portfolioBase = 0;
    for (const h of holdings) {
      if (h.assetType === 'stock' || h.assetType === 'etf') {
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
    let assets = 0;
    let liab = 0;
    for (const a of manualAssets) {
      const conv = convertSync(a.value, a.currency, baseCurrency, fxRates);
      if (conv == null) continue;
      if (LIABILITY_TYPES.includes(a.assetType)) liab += conv;
      else assets += conv;
    }
    return Math.max(0, portfolioBase + assets - liab);
  }, [holdings, stockQuotes, cryptoPrices, fxRates, manualAssets, baseCurrency]);

  // Input state — initialised once from current net worth.
  // v1.18.1 (NCC#166): the three typed fields keep what was typed and are read
  // with numberInput. `Number(e.target.value) || 0` turned "150,50" into 0,
  // and since the field showed the parsed number, typing "4," or "4." wiped
  // the separator before the decimals could follow it.
  const [startingBalanceText, setStartingBalanceText] = useState<string>(String(Math.round(currentNetWorth)));
  const [monthly, setMonthly] = useState<number>(500);
  const [years, setYears] = useState<number>(20);
  const [conservativeText, setConservativeText] = useState<string>(String(CONSERVATIVE_DEFAULT));
  const [optimisticText, setOptimisticText] = useState<string>(String(OPTIMISTIC_DEFAULT));
  // v1.18.1 (NCC#166): a half-typed or out-of-range entry ("", "-", "1e400",
  // a rate under -100%) reads as a usable number, never NaN or Infinity.
  const finite = (s: string) => {
    const n = numberInput(s);
    return Number.isFinite(n) ? n : 0;
  };
  const startingBalance = finite(startingBalanceText);
  const conservativePct = Math.max(-99, finite(conservativeText));
  const optimisticPct = Math.max(-99, finite(optimisticText));
  const startingTouched = useRef(false);
  const [inflationPct, setInflationPct] = useState<number>(INFLATION_DEFAULT);
  const [showInToday, setShowInToday] = useState<boolean>(false);

  // Re-init startingBalance if net worth loads after the screen mounts.
  // We only auto-fill when the user hasn't touched the input — a 0 initial
  // value is a strong signal that net worth wasn't ready on first render.
  useEffect(() => {
    if (!startingTouched.current && startingBalance === 0 && currentNetWorth > 0) {
      // HYG-4: Seeds an editable input from data that may arrive after mount.
      // Only until the user types in it: clearing the field or starting "0,5"
      // is not a reason to put net worth back.
      setStartingBalanceText(String(Math.round(currentNetWorth)));
    }
  }, [currentNetWorth, startingBalance]);

  const conservative = useMemo(
    () =>
      project({
        startingBalance,
        monthlyContribution: monthly,
        annualReturnRate: conservativePct / 100,
        years,
        annualInflationRate: inflationPct / 100,
      }),
    [startingBalance, monthly, conservativePct, years, inflationPct],
  );

  const optimistic = useMemo(
    () =>
      project({
        startingBalance,
        monthlyContribution: monthly,
        annualReturnRate: optimisticPct / 100,
        years,
        annualInflationRate: inflationPct / 100,
      }),
    [startingBalance, monthly, optimisticPct, years, inflationPct],
  );

  const fmtMoney = (n: number) =>
    new Intl.NumberFormat(formatLocale(), {
      style: 'currency',
      currency: baseCurrency,
      maximumFractionDigits: 0,
    }).format(n);

  // Determine which milestones are actually reachable so we don't render
  // "€1M: never" for someone projecting a 5-year horizon — it just clutters.
  const milestoneRows = useMemo(() => {
    return milestonesFor(startingBalance).map((target) => ({
      target,
      conservative: yearReachingMilestone(conservative.points, target, showInToday),
      optimistic: yearReachingMilestone(optimistic.points, target, showInToday),
    })).filter((row) => row.conservative != null || row.optimistic != null);
  }, [conservative, optimistic, showInToday, startingBalance]);

  const finalCons = showInToday ? conservative.finalReal : conservative.finalNominal;
  const finalOpt = showInToday ? optimistic.finalReal : optimistic.finalNominal;

  return (
    <>
      <AppHeader title={t('fin.wi.title')} back="/finance/networth" backLabel={t('fin.ov.netWorth')} showAvatar={false} />
      <div className="space-y-3">
        {/* Inputs */}
        <div className="card space-y-3">
          <div className="font-heading font-semibold text-sm">{t('fin.wi.scenario')}</div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-[0.625rem] uppercase tracking-wider text-text-muted">
                {t('fin.wi.startingBalance')}
              </span>
              <span className="text-[0.625rem] text-text-muted">
                {t('fin.wi.autoFilled')}
              </span>
            </div>
            <input
              className="input"
              // v1.18.1 (NCC#166): 'numeric' gives a phone keypad with no
              // separator at all; the other money fields use 'decimal'.
              inputMode="decimal"
              value={startingBalanceText}
              onChange={(e) => {
                startingTouched.current = true;
                setStartingBalanceText(e.target.value);
              }}
            />
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-[0.625rem] uppercase tracking-wider text-text-muted">
                {t('fin.wi.monthly')}
              </span>
              <span className="text-xs">{fmtMoney(monthly)}</span>
            </div>
            <input
              type="range"
              min={0}
              max={5000}
              step={50}
              value={monthly}
              onChange={(e) => setMonthly(Number(e.target.value))}
              className="w-full accent-primary"
            />
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-[0.625rem] uppercase tracking-wider text-text-muted">
                {t('fin.wi.horizon')}
              </span>
              <span className="text-xs">{t('fin.wi.yearsN', { n: years })}</span>
            </div>
            <input
              type="range"
              min={1}
              max={40}
              step={1}
              value={years}
              onChange={(e) => setYears(Number(e.target.value))}
              className="w-full accent-primary"
            />
          </div>
        </div>

        {/* Return rates */}
        <div className="card space-y-3">
          <div className="font-heading font-semibold text-sm">{t('fin.wi.returnRates')}</div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <div className="text-[0.625rem] uppercase tracking-wider text-text-muted mb-1">
                {t('fin.wi.conservative')}
              </div>
              <div className="flex items-center gap-1">
                <input
                  className="input flex-1"
                  inputMode="decimal"
                  value={conservativeText}
                  onChange={(e) => setConservativeText(e.target.value)}
                />
                <span className="text-text-muted text-sm">%</span>
              </div>
            </div>
            <div>
              <div className="text-[0.625rem] uppercase tracking-wider text-text-muted mb-1">
                {t('fin.wi.optimistic')}
              </div>
              <div className="flex items-center gap-1">
                <input
                  className="input flex-1"
                  inputMode="decimal"
                  value={optimisticText}
                  onChange={(e) => setOptimisticText(e.target.value)}
                />
                <span className="text-text-muted text-sm">%</span>
              </div>
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-[0.625rem] uppercase tracking-wider text-text-muted">
                {t('fin.wi.inflation')}
              </span>
              <span className="text-xs">{t('fin.wi.perYr', { pct: inflationPct.toFixed(1) })}</span>
            </div>
            <input
              type="range"
              min={0}
              max={6}
              step={0.1}
              value={inflationPct}
              onChange={(e) => setInflationPct(Number(e.target.value))}
              className="w-full accent-primary"
            />
          </div>

          <div className="flex items-center justify-between pt-1 border-t border-border/40">
            <div>
              <div className="text-sm">{t('fin.wi.showToday')}</div>
              <div className="text-[0.625rem] text-text-muted">
                {t('fin.wi.deflates')}
              </div>
            </div>
            <button
              onClick={() => setShowInToday((v) => !v)}
              className={`relative w-10 h-6 p-0 rounded-full transition-colors flex-shrink-0 ${
                showInToday ? 'bg-primary' : 'bg-surface2 border border-border'
              }`}
              aria-pressed={showInToday}
            >
              {/* Anchor the knob at left-0.5 (2px) so its rest position is
                * predictable. With a 40px track and a 20px knob, translating
                * 16px puts it 2px from the right edge — symmetric inset. */}
              <span
                className={`absolute top-0.5 start-0.5 w-5 h-5 rounded-full bg-text transition-transform ${
                  showInToday ? 'translate-x-4 rtl:-translate-x-4' : 'translate-x-0'
                }`}
              />
            </button>
          </div>
        </div>

        {/* Chart */}
        <ProjectionChart
          conservative={conservative.points.map((p) =>
            showInToday ? p.balanceReal : p.balanceNominal,
          )}
          optimistic={optimistic.points.map((p) =>
            showInToday ? p.balanceReal : p.balanceNominal,
          )}
          years={years}
        />

        {/* Result summary */}
        <div className="card space-y-2">
          <div className="font-heading font-semibold text-sm">
            {t('fin.wi.inYears', { n: years })}
            {showInToday && (
              <span className="text-[0.625rem] uppercase tracking-wider text-text-muted ms-2">
                · {t('fin.wi.todayMoney')}
              </span>
            )}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-sm border border-border bg-surface2/40 p-2">
              <div className="text-[0.625rem] uppercase tracking-wider text-text-muted">
                {t('fin.wi.consPct', { pct: conservativePct })}
              </div>
              <div className="font-heading font-bold text-lg">{fmtMoney(finalCons)}</div>
            </div>
            <div className="rounded-sm border border-success/40 bg-success/5 p-2">
              <div className="text-[0.625rem] uppercase tracking-wider text-success">
                {t('fin.wi.optPct', { pct: optimisticPct })}
              </div>
              <div className="font-heading font-bold text-lg">{fmtMoney(finalOpt)}</div>
            </div>
          </div>
          <div className="text-[0.625rem] text-text-muted">
            {t('fin.wi.totalContrib', { n: years })}{' '}
            <span className="text-text">{fmtMoney(conservative.totalContributions)}</span>
            {' · '}{t('fin.wi.growthAbove')}{' '}
            <span className="text-text">
              {fmtMoney(finalCons - startingBalance - conservative.totalContributions)}
            </span>{' '}
            – {fmtMoney(finalOpt - startingBalance - optimistic.totalContributions)}
          </div>
        </div>

        {/* Milestones */}
        {milestoneRows.length > 0 && (
          <div className="card">
            <div className="font-heading font-semibold text-sm mb-2">{t('fin.wi.milestones')}</div>
            <div className="space-y-1">
              <div className="grid grid-cols-3 gap-2 text-[0.5625rem] uppercase tracking-wider text-text-muted pb-1 border-b border-border/40">
                <span>{t('fin.wi.target')}</span>
                <span className="text-center">{t('fin.wi.conservative')}</span>
                <span className="text-end">{t('fin.wi.optimistic')}</span>
              </div>
              {milestoneRows.map((row) => (
                <div key={row.target} className="grid grid-cols-3 gap-2 text-xs py-1">
                  <span className="font-heading">{fmtMoney(row.target)}</span>
                  <span className="text-center text-text-muted">
                    {row.conservative != null ? t('fin.wi.inYearsShort', { n: row.conservative }) : '—'}
                  </span>
                  <span className="text-end text-success">
                    {row.optimistic != null ? t('fin.wi.inYearsShort', { n: row.optimistic }) : '—'}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Honesty footnote */}
        <div className="card text-[0.625rem] text-text-muted space-y-1">
          <div className="font-heading uppercase tracking-wider text-[0.5625rem] text-text">
            {t('fin.wi.assumptions')}
          </div>
          <div>• {t('fin.wi.assume1')}</div>
          <div>• {t('fin.wi.assume2')}</div>
          <div>• {t('fin.wi.assume3')}</div>
          <div>• {t('fin.wi.assume4')}</div>
        </div>
      </div>
    </>
  );
}

/** Two-line projection chart with shaded uncertainty band. */
function ProjectionChart({
  conservative,
  optimistic,
  years,
}: {
  conservative: number[];
  optimistic: number[];
  years: number;
}) {
  const { t } = useTranslation();
  const W = 320;
  const H = 140;
  const PAD_L = 4;
  const PAD_R = 4;
  const PAD_T = 8;
  const PAD_B = 16;

  const innerW = W - PAD_L - PAD_R;
  const innerH = H - PAD_T - PAD_B;

  // Always use the optimistic max for the y-axis upper bound — it's the
  // bigger of the two lines by definition. Start from 0 so the user sees
  // the actual scale of growth, not a misleading zoomed view.
  const yMax = Math.max(...optimistic, 1);
  const yMin = 0;
  const ySpan = yMax - yMin;

  const xs = (i: number, n: number) => PAD_L + (i / Math.max(1, n - 1)) * innerW;
  const ys = (v: number) => PAD_T + innerH - ((v - yMin) / ySpan) * innerH;

  const consPath = conservative
    .map((v, i) => `${i === 0 ? 'M' : 'L'} ${xs(i, conservative.length)} ${ys(v)}`)
    .join(' ');
  const optPath = optimistic
    .map((v, i) => `${i === 0 ? 'M' : 'L'} ${xs(i, optimistic.length)} ${ys(v)}`)
    .join(' ');

  // Shaded band: optimistic top → conservative bottom (closed polygon).
  const bandPath =
    optimistic.map((v, i) => `${i === 0 ? 'M' : 'L'} ${xs(i, optimistic.length)} ${ys(v)}`).join(' ') +
    ' ' +
    conservative
      .slice()
      .reverse()
      .map((v, i) => `L ${xs(conservative.length - 1 - i, conservative.length)} ${ys(v)}`)
      .join(' ') +
    ' Z';

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-2">
        <span className="font-heading font-semibold text-sm">{t('fin.wi.projection')}</span>
        <div className="flex items-center gap-2 text-[0.5625rem] uppercase tracking-wider">
          <span className="flex items-center gap-1 text-text-muted">
            <span className="inline-block w-2 h-2 rounded-sm bg-text-muted/60" />
            {t('fin.wi.consShort')}
          </span>
          <span className="flex items-center gap-1 text-success">
            <span className="inline-block w-2 h-2 rounded-sm bg-success" />
            {t('fin.wi.optShort')}
          </span>
        </div>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" width="100%" height={H} className="block">
        {/* Light gridline at 50% so the eye has a reference */}
        <line
          x1={PAD_L}
          x2={W - PAD_R}
          y1={PAD_T + innerH / 2}
          y2={PAD_T + innerH / 2}
          stroke={RULE}
          strokeDasharray="2 3"
          strokeWidth={0.5}
        />
        <path d={bandPath} fill="rgba(78, 154, 107, 0.10)" />
        <path d={consPath} fill="none" stroke={INK_MUTE} strokeWidth={1.5} strokeLinejoin="round" />
        <path d={optPath} fill="none" stroke={SUCCESS} strokeWidth={2} strokeLinejoin="round" />
      </svg>
      <div className="flex justify-between text-[0.5625rem] text-text-muted mt-1">
        <span>{t('fin.wi.today')}</span>
        <span>{t('fin.wi.plusYears', { n: Math.floor(years / 2) })}</span>
        <span>{t('fin.wi.plusYears', { n: years })}</span>
      </div>
    </div>
  );
}
