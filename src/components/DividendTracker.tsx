// Projected annual dividend income, summed across held equities.
//
// Computation per holding:
//   trailing12m = sum of dividend amounts in the last 365 days
//   projectedAnnual = trailing12m × quantity, converted to base currency
//
// Summary card shows total projected income + next ex-div date strip.
// Per-holding rows tappable to open the detail sheet.

import { useMemo } from 'react';
import type { PortfolioHolding } from '../types/finance';
import type { DividendEvent } from '../api/stockDetail';
import { convertSync } from '../api/fxRates';
import { localDateKey } from '@/utils/formatters';

interface Props {
  holdings: PortfolioHolding[];
  dividends: Record<string, DividendEvent[]>;
  fxRates: Record<string, number> | null;
  baseCurrency: string;
  formatCurrency: (amount: number, currency: string) => string;
  /** v1.7 — dividends auto-realized into portfolio cash this calendar year,
   *  base currency. Shown as a "realized" counterpoint to projected income. */
  realizedYtd?: number;
  onTapTicker?: (ticker: string) => void;
}

interface DividendRow {
  ticker: string;
  trailingPerShare: number;
  trailingCurrency: string;
  projectedAnnualBase: number;
  nextExDiv?: string;
}

function buildRow(
  h: PortfolioHolding,
  events: DividendEvent[],
  fxRates: Record<string, number> | null,
  baseCurrency: string,
): DividendRow | null {
  if (!events.length) return null;
  // Trailing 12 months — keep events with ex-div date in the past year.
  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - 1);
  const cutoffKey = cutoff.toISOString().slice(0, 10);
  const past = events.filter((e) => e.date <= localDateKey(new Date()) && e.date >= cutoffKey);
  if (past.length === 0) return null;
  // All dividends for one ticker share a currency in practice, so use the
  // first event's currency as the basis. Sum amounts straight (per-share).
  const currency = past[0].currency;
  const trailingPerShare = past.reduce((acc, e) => acc + e.amount, 0);
  const trailingTotalNative = trailingPerShare * h.quantity;
  const projectedAnnualBase =
    convertSync(trailingTotalNative, currency, baseCurrency, fxRates) ?? 0;
  // Next ex-div = earliest future date in the events list.
  const today = localDateKey(new Date());
  const futureEvents = events.filter((e) => e.date > today).sort((a, b) => a.date.localeCompare(b.date));
  return {
    ticker: h.ticker.toUpperCase(),
    trailingPerShare,
    trailingCurrency: currency,
    projectedAnnualBase,
    nextExDiv: futureEvents[0]?.date,
  };
}

export default function DividendTracker({
  holdings,
  dividends,
  fxRates,
  baseCurrency,
  formatCurrency,
  realizedYtd,
  onTapTicker,
}: Props) {
  const rows = useMemo(() => {
    const out: DividendRow[] = [];
    for (const h of holdings) {
      if (h.assetType === 'crypto') continue;
      const events = dividends[h.ticker.toUpperCase()];
      if (!events) continue;
      const r = buildRow(h, events, fxRates, baseCurrency);
      if (r) out.push(r);
    }
    return out.sort((a, b) => b.projectedAnnualBase - a.projectedAnnualBase);
  }, [holdings, dividends, fxRates, baseCurrency]);

  if (rows.length === 0) return null;

  const totalProjected = rows.reduce((acc, r) => acc + r.projectedAnnualBase, 0);

  // Imminent ex-div (within 30 days)
  const today = localDateKey(new Date());
  const soon = rows
    .filter((r) => r.nextExDiv && r.nextExDiv >= today)
    .sort((a, b) => (a.nextExDiv ?? '').localeCompare(b.nextExDiv ?? ''))[0];

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-3">
        <span className="font-heading font-semibold text-sm">Dividends</span>
        <span className="text-[0.5625rem] uppercase tracking-wider text-success border border-success/40 bg-success/5 rounded-sm px-1.5 py-0.5">
          Projected Annual
        </span>
      </div>
      <div className="mb-3">
        <div className="text-[0.625rem] uppercase tracking-[0.15em] text-text-muted">
          Projected income · trailing 12m
        </div>
        <div className="font-heading font-bold text-xl tracking-tight">
          {formatCurrency(totalProjected, baseCurrency)}
        </div>
        {realizedYtd != null && realizedYtd > 0 && (
          <div className="text-[0.625rem] text-text-muted mt-1">
            Realized this year:{' '}
            <span className="text-success font-medium">
              {formatCurrency(realizedYtd, baseCurrency)}
            </span>
          </div>
        )}
        {soon && soon.nextExDiv && (
          <div className="text-[0.625rem] text-text-muted mt-1">
            Next ex-div: <span className="text-text font-medium">{soon.ticker}</span> on {soon.nextExDiv}
          </div>
        )}
      </div>
      <div className="space-y-1">
        {rows.map((r) => (
          <button
            key={r.ticker}
            onClick={() => onTapTicker?.(r.ticker)}
            className="w-full flex items-center justify-between py-1.5 px-1 rounded-sm active:bg-surface2/50 text-start"
          >
            <div className="min-w-0">
              <div className="text-sm font-medium truncate">{r.ticker}</div>
              <div className="text-[0.5625rem] text-text-muted">
                {r.trailingPerShare.toFixed(2)} {r.trailingCurrency}/share · trailing
              </div>
            </div>
            <div className="text-end">
              <div className="text-xs font-medium text-success">
                {formatCurrency(r.projectedAnnualBase, baseCurrency)}
              </div>
              {r.nextExDiv && (
                <div className="text-[0.5625rem] text-text-muted">ex-div {r.nextExDiv}</div>
              )}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
