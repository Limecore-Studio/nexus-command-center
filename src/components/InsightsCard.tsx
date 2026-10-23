// Auto-generated observations about the portfolio + net worth. Each insight
// is derived from existing store state — no new API calls. Rules:
//   - Don't render the card unless at least one insight has fired.
//   - Insights are advisory, not prescriptive. Phrasing avoids "you should".
//   - Each insight has a tone (info / warn / good) for color-coding.

import { useMemo } from 'react';
import { formatMoney } from '../lib/currencies';
import { formatLocale } from '../utils/formatters';
import { useFinanceStore } from '../store/useFinanceStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { convertSync } from '../api/fxRates';
import { holdingValueBase } from '../lib/positionValue';
import { LIABILITY_TYPES } from '../types/finance';
import type { PortfolioHolding } from '../types/finance';

interface Insight {
  id: string;
  tone: 'info' | 'warn' | 'good';
  text: string;
}

function fmt(amount: number, currency: string): string {
  return formatMoney(amount, currency, { locale: formatLocale(), min: 0, max: 0 });
}

export default function InsightsCard() {
  const holdings = useFinanceStore((s) => s.holdings);
  const portfolioLots = useFinanceStore((s) => s.portfolioLots);
  const stockQuotes = useFinanceStore((s) => s.stockQuotes);
  const cryptoPrices = useFinanceStore((s) => s.cryptoPrices);
  const sparklines = useFinanceStore((s) => s.sparklines);
  const fxRates = useFinanceStore((s) => s.fxRates);
  const manualAssets = useFinanceStore((s) => s.manualAssets);
  const baseCurrency = useSettingsStore((s) => s.baseCurrency);

  const insights = useMemo<Insight[]>(() => {
    const out: Insight[] = [];

    // Compute portfolio value + per-position base values for downstream rules.
    const positions: { ticker: string; valueBase: number; kind: PortfolioHolding['assetType'] }[] = [];
    let portfolioBase = 0;
    let cryptoBase = 0;
    for (const h of holdings) {
      // v1.9 — was an inline copy of Portfolio.tsx's conversion. Same maths,
      // now from one module, so a fix to either can't leave the other behind.
      const v = holdingValueBase(h, stockQuotes, cryptoPrices, fxRates, baseCurrency, portfolioLots);
      if (v != null) {
        positions.push({ ticker: h.ticker, valueBase: v, kind: h.assetType });
        portfolioBase += v;
        if (h.assetType === 'crypto') cryptoBase += v;
      }
    }

    // Manual liquid cash + total assets+liabilities (in base).
    let liquidBase = 0;
    let manualAssetsBase = 0;
    let liabBase = 0;
    for (const a of manualAssets) {
      const conv = convertSync(a.value, a.currency, baseCurrency, fxRates);
      if (conv == null) continue;
      if (LIABILITY_TYPES.includes(a.assetType)) liabBase += conv;
      else manualAssetsBase += conv;
      if (a.assetType === 'cash' || a.assetType === 'savings') liquidBase += conv;
    }
    const totalAssetsBase = portfolioBase + manualAssetsBase;
    const netWorthBase = totalAssetsBase - liabBase;

    // — Concentration: top holding > 30% of portfolio
    if (positions.length > 0 && portfolioBase > 0) {
      const top = positions.sort((a, b) => b.valueBase - a.valueBase)[0];
      const pct = (top.valueBase / portfolioBase) * 100;
      if (pct >= 30) {
        out.push({
          id: 'concentration',
          tone: pct >= 50 ? 'warn' : 'info',
          text: `${top.ticker.toUpperCase()} is ${pct.toFixed(0)}% of your portfolio.`,
        });
      }
    }

    // — Crypto exposure
    if (portfolioBase > 0 && cryptoBase > 0) {
      const pct = (cryptoBase / portfolioBase) * 100;
      if (pct >= 25) {
        out.push({
          id: 'crypto',
          tone: pct >= 50 ? 'warn' : 'info',
          text: `Crypto is ${pct.toFixed(0)}% of your portfolio (${fmt(cryptoBase, baseCurrency)}).`,
        });
      }
    }

    // — Cash drag: liquid cash > 25% of net worth
    if (netWorthBase > 0 && liquidBase > 0) {
      const pct = (liquidBase / netWorthBase) * 100;
      if (pct >= 25) {
        out.push({
          id: 'cash-drag',
          tone: 'info',
          text: `${pct.toFixed(0)}% of net worth is in cash/savings (${fmt(liquidBase, baseCurrency)}). Consider deploying if this is unintentional.`,
        });
      }
    }

    // — Top mover (7-day): largest absolute % move on sparkline among held tickers
    let topMover: { ticker: string; pct: number } | null = null;
    for (const p of positions) {
      const key = p.kind === 'crypto' ? p.ticker.toLowerCase() : p.ticker.toUpperCase();
      const series = sparklines[key];
      if (!series || series.length < 2) continue;
      const first = series[0];
      const last = series[series.length - 1];
      if (first === 0) continue;
      const pct = ((last - first) / first) * 100;
      if (!topMover || Math.abs(pct) > Math.abs(topMover.pct)) {
        topMover = { ticker: p.ticker, pct };
      }
    }
    if (topMover && Math.abs(topMover.pct) >= 5) {
      out.push({
        id: 'mover',
        tone: topMover.pct >= 0 ? 'good' : 'warn',
        text: `${topMover.ticker.toUpperCase()} ${topMover.pct >= 0 ? '+' : ''}${topMover.pct.toFixed(1)}% over the past 7 days.`,
      });
    }

    // — Leverage: liabilities > 40% of assets
    if (totalAssetsBase > 0 && liabBase > 0) {
      const pct = (liabBase / totalAssetsBase) * 100;
      if (pct >= 40) {
        out.push({
          id: 'leverage',
          tone: 'warn',
          text: `Liabilities are ${pct.toFixed(0)}% of total assets (${fmt(liabBase, baseCurrency)}).`,
        });
      }
    }

    return out;
  }, [holdings, portfolioLots, stockQuotes, cryptoPrices, sparklines, fxRates, manualAssets, baseCurrency]);

  if (insights.length === 0) return null;

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-2">
        <span className="font-heading font-semibold text-sm">Insights</span>
        <span className="text-[0.5625rem] uppercase tracking-wider text-text-muted">
          {insights.length} observation{insights.length === 1 ? '' : 's'}
        </span>
      </div>
      <div className="space-y-1.5">
        {insights.map((i) => (
          <div
            key={i.id}
            className={`flex items-start gap-2 py-1.5 px-2 rounded-sm border ${
              i.tone === 'good'
                ? 'border-success/30 bg-success/5'
                : i.tone === 'warn'
                  ? 'border-warning/30 bg-warning/5'
                  : 'border-border bg-surface2/30'
            }`}
          >
            <span className={`text-xs flex-shrink-0 mt-0.5 ${
              i.tone === 'good' ? 'text-success' : i.tone === 'warn' ? 'text-warning' : 'text-text-muted'
            }`}>
              {i.tone === 'good' ? '↑' : i.tone === 'warn' ? '!' : '•'}
            </span>
            <span className="text-xs leading-snug">{i.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
