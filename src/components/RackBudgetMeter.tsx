// v1.15 (Item 13) — Rack's primary meter: this month's budget read off a
// cream-lit scale with the limit printed on it, so 91% is visibly in the red
// zone rather than merely coloured red. Rack-only; the free theme keeps its
// StatCard. Callers gate on the active theme.
import { useTranslation } from 'react-i18next';
import Meter from './Meter';
import { formatCurrency } from '../utils/formatters';
import { useSettingsStore } from '../store/useSettingsStore';

interface Props {
  spent: number;
  limit: number;
  /** Last month's total spend — the held peak the tick sits at. */
  lastMonthSpent?: number;
}

// Where the printed red zone starts — the same 90% the StatCard's danger tone
// already switches at, so the two themes agree about when a budget is in
// trouble.
const RED_ZONE_FROM = 90;

export default function RackBudgetMeter({ spent, limit, lastMonthSpent }: Props) {
  const baseCurrency = useSettingsStore((s) => s.baseCurrency);
  const { t } = useTranslation();
  const pct = limit > 0 ? Math.round((spent / limit) * 100) : 0;
  const now = new Date();
  const month = now.toLocaleDateString(undefined, { month: 'long' });
  const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1).toLocaleDateString(undefined, { month: 'short' });
  const hasPeak = lastMonthSpent != null && lastMonthSpent > 0 && limit > 0;
  const peakPct = hasPeak ? Math.round((lastMonthSpent / limit) * 100) : null;
  return (
    <div className="panel px-3 py-2.5">
      <div className="flex items-center justify-between">
        <span className="sec">{t('rack.budgetMeter', { month })}</span>
        <span className="font-mono text-xs text-primary tabular-nums">{pct}%</span>
      </div>
      <div className="mt-2 p-2" style={{ background: 'var(--meter-face)' }}>
        <Meter
          value={spent}
          max={limit}
          redZoneFrom={RED_ZONE_FROM}
          // Spend is the one meter where a new peak is bad news, so past last
          // month's mark the tick goes to the needle; otherwise it holds.
          peak={hasPeak ? lastMonthSpent : undefined}
          peakTone={hasPeak && spent > lastMonthSpent ? 'new' : 'ok'}
          showScale
          height={11}
          label={t('rack.budgetMeterAria', { pct })}
        />
        <div className="flex items-baseline justify-between gap-2 mt-1.5">
          <div className="meter-readout text-xl">
            {formatCurrency(Math.max(0, limit - spent), baseCurrency)}
            <span className="meter-readout__unit">{t('rack.left')}</span>
          </div>
          {peakPct != null && (
            <span className="meter-scale-label">{t('rack.peak', { pct: peakPct, month: prevMonth })}</span>
          )}
        </div>
      </div>
    </div>
  );
}
