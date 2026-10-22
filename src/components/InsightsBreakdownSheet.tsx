import BottomSheet from './BottomSheet';
import { TIER_LABEL } from '../lib/insightTiers';
import type { CompositeRating, CompositeBreakdown } from '../lib/insightsScore';
import type { FundamentalRating, FundamentalBreakdown } from '../lib/fundamentalsScore';
import type { SignalResult } from '../lib/insightSignals';

/**
 * Bottom sheet showing the per-signal breakdown for one composite rating.
 * v1.2 — generalized to render either a Technical (5-signal) or
 * Fundamental (8-signal) rating; both branches use the same SignalRow
 * primitive because their `SignalResult` shape is shared.
 *
 * Each signal row renders:
 *   - signal name
 *   - score visualized as a horizontal bar centered on 0 (bullish right,
 *     bearish left)
 *   - one-line detail
 *
 * Unavailable signals render as a muted "—" row so the user understands the
 * composite was computed on partial data.
 */

type AnyRating =
  | { kind: 'technical'; rating: CompositeRating }
  | { kind: 'fundamental'; rating: FundamentalRating };

interface Props {
  open: boolean;
  onClose: () => void;
  rating: AnyRating | null;
}

const TECHNICAL_LABEL: Record<keyof CompositeBreakdown, string> = {
  rsi:       'RSI(14)',
  sma:       'SMA cross',
  momentum:  'Momentum',
  volume:    'Volume',
  sentiment: 'Sentiment',
};

const FUNDAMENTAL_LABEL: Record<keyof FundamentalBreakdown, string> = {
  peVsSector:       'P/E vs sector',
  pbRatio:          'P/B',
  psVsSector:       'P/S vs sector',
  pegRatio:         'PEG',
  debtToEquity:     'Debt / equity',
  revenueGrowth:    'Revenue growth YoY',
  earningsSurprise: 'Earnings surprises',
  analystConsensus: 'Analyst consensus',
};

const TECHNICAL_FOOTNOTE =
  'Technical signals are heuristic — not investment advice. Composite blends ' +
  'available signals weighted 25/25/20/15/15 (SMA/Momentum/RSI/Volume/Sentiment).';
const FUNDAMENTAL_FOOTNOTE =
  'Fundamental signals draw on Finnhub metrics + sector benchmark medians ' +
  '(P/E vs sector, P/B, P/S, PEG, debt/equity, YoY revenue growth, ' +
  'earnings-surprise history, analyst consensus). Composite weights ' +
  '20% analyst / 15% earnings / 15% growth / 10% each P/E, P/B, P/S, PEG, D/E.';

export default function InsightsBreakdownSheet({ open, onClose, rating }: Props) {
  if (!rating) {
    return (
      <BottomSheet open={open} onClose={onClose} title="Insights">
        <div className="text-xs text-text-muted py-6 text-center">
          No rating computed yet — pull to refresh from the Insights tab.
        </div>
      </BottomSheet>
    );
  }

  const { rating: r } = rating;
  const isFundamental = rating.kind === 'fundamental';
  const labels: Record<string, string> = isFundamental ? FUNDAMENTAL_LABEL : TECHNICAL_LABEL;
  const entries = Object.entries(r.breakdown) as [string, SignalResult][];
  const tabPrefix = isFundamental ? 'Fundamental' : 'Technical';
  const footnote = isFundamental ? FUNDAMENTAL_FOOTNOTE : TECHNICAL_FOOTNOTE;

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title={`${r.ticker} · ${TIER_LABEL[r.tier]}`}
    >
      <div className="space-y-3">
        <div className="flex items-baseline justify-between">
          <div className="font-heading font-bold text-3xl tracking-tight">
            {r.score >= 0 ? '+' : ''}{r.score.toFixed(0)}
          </div>
          <div className="text-[0.625rem] text-text-muted uppercase tracking-wider">
            {tabPrefix} · {new Date(r.computedAt).toLocaleTimeString()}
          </div>
        </div>
        {r.partial && (
          <div className="alert alert-warn">
            Partial coverage — one or more signals lacked data.
          </div>
        )}
        <div className="space-y-2.5 stagger-children">
          {entries.map(([key, signal]) => (
            <SignalRow key={key} label={labels[key] ?? key} signal={signal} />
          ))}
        </div>
        <div className="text-[0.625rem] text-text-muted text-center">
          {footnote}
        </div>
      </div>
    </BottomSheet>
  );
}

interface SignalRowProps {
  label: string;
  signal: SignalResult;
}

function SignalRow({ label, signal }: SignalRowProps) {
  if (!signal.available) {
    return (
      <div className="panel-2 p-3 opacity-60">
        <div className="flex items-baseline justify-between">
          <div className="font-heading font-semibold text-sm">{label}</div>
          <div className="text-text-muted text-xs">—</div>
        </div>
        <div className="text-[0.625rem] text-text-muted mt-0.5">{signal.detail}</div>
      </div>
    );
  }
  // Bar visualization — width % of one half-track based on |score|/100.
  const half = Math.min(100, Math.abs(signal.score));
  const tone = signal.score > 0 ? 'success' : signal.score < 0 ? 'danger' : 'muted';
  const toneColor = tone === 'success'
    ? 'bg-success/70'
    : tone === 'danger'
      ? 'bg-danger/70'
      : 'bg-text-muted/50';
  const scoreText = tone === 'success'
    ? 'text-success'
    : tone === 'danger'
      ? 'text-danger'
      : 'text-text-muted';

  return (
    <div className="panel p-3">
      <div className="flex items-baseline justify-between">
        <div className="font-heading font-semibold text-sm">{label}</div>
        <div className={`text-xs font-medium ${scoreText}`}>
          {signal.score > 0 ? '+' : ''}{signal.score.toFixed(0)}
        </div>
      </div>
      <div className="text-[0.625rem] text-text-muted mt-0.5">{signal.label}</div>
      {/* Center-anchored bar — left half is bearish, right half bullish.
          The zero line sits at 50%; positive scores extend rightward, negatives
          leftward. */}
      <div className="relative h-1.5 mt-2 rounded-full bg-surface2 overflow-hidden">
        <div className="absolute top-0 bottom-0 left-1/2 w-px bg-text-muted/40" />
        <div
          className={`absolute top-0 bottom-0 ${toneColor}`}
          style={
            signal.score >= 0
              ? { left: '50%', width: `${half / 2}%` }
              : { right: '50%', width: `${half / 2}%` }
          }
        />
      </div>
      <div className="text-[0.625rem] text-text-muted mt-1.5">{signal.detail}</div>
    </div>
  );
}
