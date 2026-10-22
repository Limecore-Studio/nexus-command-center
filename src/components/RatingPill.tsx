import { useInsightsStore } from '../store/useInsightsStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { TIER_LABEL, type InsightTier } from '../lib/insightTiers';

/**
 * v1.2 — small inline pill showing the current Insights tier for a ticker.
 *
 * Used inline on portfolio + watchlist rows. Reads the active tab choice
 * (`useSettingsStore.insightsTab`) and pulls from either the technical or
 * fundamental ratings map accordingly. Both maps live on the same store so
 * the swap doesn't change the subscription shape.
 *
 * Shows a muted "—" placeholder when no rating is yet computed for the
 * active tab (cold start, pre-recompute, or signal coverage is empty).
 * Tapping doesn't open a sheet from this component — the row's existing
 * tap handler does that. The pill is informational only.
 */

const TIER_TONE: Record<InsightTier, { bg: string; text: string; border: string }> = {
  strong_buy:  { bg: 'rgba(63, 185, 80, 0.18)',  text: 'text-success', border: 'border-success/55' },
  buy:         { bg: 'rgba(63, 185, 80, 0.10)',  text: 'text-success', border: 'border-success/35' },
  hold:        { bg: 'rgba(125, 133, 144, 0.10)', text: 'text-text-muted', border: 'border-border' },
  sell:        { bg: 'rgba(248, 81, 73, 0.10)',   text: 'text-danger',  border: 'border-danger/35' },
  strong_sell: { bg: 'rgba(248, 81, 73, 0.18)',   text: 'text-danger',  border: 'border-danger/55' },
};

const TIER_GLYPH: Record<InsightTier, string> = {
  strong_buy:  '▲▲',
  buy:         '▲',
  hold:        '•',
  sell:        '▼',
  strong_sell: '▼▼',
};

interface RatingPillProps {
  ticker: string;
  /** Compact = no label, just the arrow + tier short. Default false. */
  compact?: boolean;
  className?: string;
}

export default function RatingPill({ ticker, compact = false, className = '' }: RatingPillProps) {
  const upper = ticker.toUpperCase();
  const insightsTab = useSettingsStore((s) => s.insightsTab);
  // Subscribe to both maps so the pill swaps instantly when the user
  // flips the tab toggle anywhere in the app — without forcing every
  // pill consumer to know about the setting.
  const technical = useInsightsStore((s) => s.ratings[upper] ?? null);
  const fundamental = useInsightsStore((s) => s.fundamentals[upper] ?? null);
  const rating = insightsTab === 'fundamental' ? fundamental : technical;

  if (!rating) {
    return (
      <span
        className={`inline-flex items-center h-5 px-2 rounded-sm border border-border text-text-muted/50 text-[0.625rem] uppercase tracking-wide ${className}`}
        style={{ background: 'rgba(28, 33, 40, 0.30)' }}
      >
        —
      </span>
    );
  }
  const tone = TIER_TONE[rating.tier];
  const label = compact ? TIER_LABEL[rating.tier].split(' ')[0] : TIER_LABEL[rating.tier];
  // Tab prefix on the title so a user hovering on web dev sees which view
  // the pill reflects ("Technical" vs "Fundamental"); native users see it
  // in the breakdown sheet header.
  const tabPrefix = insightsTab === 'fundamental' ? 'Fundamental' : 'Technical';
  return (
    <span
      className={`inline-flex items-center gap-1 h-5 px-2 rounded-sm border ${tone.text} ${tone.border} text-[0.625rem] uppercase tracking-wide font-medium ${className}`}
      style={{ background: tone.bg }}
      title={`${tabPrefix} · Composite ${rating.score.toFixed(0)} · ${TIER_LABEL[rating.tier]}${rating.partial ? ' (partial coverage)' : ''}`}
    >
      <span aria-hidden>{TIER_GLYPH[rating.tier]}</span>
      <span>{label}</span>
    </span>
  );
}
