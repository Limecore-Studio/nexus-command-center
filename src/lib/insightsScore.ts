// ─── NCC v1.2 Insights composite scoring ─────────────────────────────────
//
// Blends the five signals from insightSignals.ts into one numeric score and
// maps that to a discrete 5-tier rating: Strong Buy / Buy / Hold / Sell /
// Strong Sell.
//
// Design intent:
//   - Composite is a weighted average of available signals. Unavailable
//     signals (insufficient data) are skipped — their weight redistributes
//     proportionally to the available ones. A holding with only RSI + SMA
//     available still gets a score; it's marked "partial coverage" so the
//     UI can warn the user.
//   - Tier boundaries are intentionally narrow at the extremes (Strong tiers
//     require |score| >= 60) so they read as conviction, not background hum.
//   - The composite returns the full per-signal breakdown alongside the
//     final score + tier so the UI can render the breakdown sheet without
//     re-running the signals.

import { getYahooHistory } from '../api/yahoo';
import { readChartMeta } from '../api/yahoo';
import { getYahooNews } from '../api/yahooFundamentals';
import {
  rsiSignal,
  smaCrossSignal,
  momentumSignal,
  volumeSignal,
  sentimentSignal,
  type SignalResult,
} from './insightSignals';

// v1.18.2 — moved to insightTiers.ts (kept off the startup chunk); re-exported.
import type { InsightTier } from './insightTiers';
export { TIER_LABEL, TIER_STEP, type InsightTier } from './insightTiers';

export interface CompositeBreakdown {
  rsi: SignalResult;
  sma: SignalResult;
  momentum: SignalResult;
  volume: SignalResult;
  sentiment: SignalResult;
}

export interface CompositeRating {
  ticker: string;
  /** Composite score in [-100, +100]. */
  score: number;
  tier: InsightTier;
  /** Per-signal results — populated even when the signal was skipped (with
   *  available=false), so the UI can show "—" rows alongside live ones. */
  breakdown: CompositeBreakdown;
  /** ISO timestamp of this computation. */
  computedAt: string;
  /** True when one or more signals were skipped due to insufficient data. */
  partial: boolean;
}

// Weights sum to 1.0. Adjust as the engine evolves; current calibration
// favors trend (SMA + momentum) over mean-reversion (RSI alone) and gives
// sentiment + volume the supporting roles they deserve given how noisy
// our underlying inputs are.
//
// Rationale:
//   - SMA 25%, Momentum 25%: trend signals are the highest-confidence read
//     when the data is available — both rest on closes alone, which is
//     Yahoo's most reliable field.
//   - RSI 20%: mean-reversion provides counterbalance at the extremes but
//     has lower hit rate than trend in trending markets.
//   - Volume 15%: volume data quality is uneven on international tickers;
//     weighted lower so a missing-volume case doesn't redistribute too much.
//   - Sentiment 15%: keyword scoring is lo-fi; honest weight matches honest
//     signal quality.
const WEIGHTS: Record<keyof CompositeBreakdown, number> = {
  rsi:       0.20,
  sma:       0.25,
  momentum:  0.25,
  volume:    0.15,
  sentiment: 0.15,
};

/** Map a composite score to its tier. Boundaries chosen so:
 *    Strong tiers require |score| >= 60 — high conviction only
 *    Buy/Sell at |score| in [20, 60) — meaningful but not extreme
 *    Hold for |score| in [-20, 20] — too noisy to act on
 */
export function scoreToTier(score: number): InsightTier {
  if (score >= 60) return 'strong_buy';
  if (score >= 20) return 'buy';
  if (score <= -60) return 'strong_sell';
  if (score <= -20) return 'sell';
  return 'hold';
}

/** Compute a composite rating from a breakdown. Pure — given the same
 *  breakdown returns the same score (modulo the computedAt timestamp).
 *  Reusable by the UI for "what-if I had different signals" diagnostics
 *  and by unit tests. */
function composeRating(
  ticker: string,
  breakdown: CompositeBreakdown,
): CompositeRating {
  let weightedSum = 0;
  let availableWeight = 0;
  let partial = false;
  const entries = Object.entries(breakdown) as [keyof CompositeBreakdown, SignalResult][];
  for (const [key, result] of entries) {
    if (result.available) {
      weightedSum += result.score * WEIGHTS[key];
      availableWeight += WEIGHTS[key];
    } else {
      partial = true;
    }
  }
  // If everything is unavailable, the composite is "hold" by definition.
  const score = availableWeight > 0 ? weightedSum / availableWeight : 0;
  return {
    ticker,
    score,
    tier: scoreToTier(score),
    breakdown,
    computedAt: new Date().toISOString(),
    partial,
  };
}

/**
 * Fetch the data needed for one ticker and compute the full composite.
 * Returns null when even the Yahoo history fetch fails — in that case the
 * UI shows a "data unavailable" state for the row.
 *
 * Caching: relies on getYahooHistory's 4h cache + the news fetch's existing
 * cache. Cold-start cost is a single Yahoo chart call + one news call per
 * ticker; subsequent calls within the window are local-only.
 */
export async function computeInsightForTicker(ticker: string): Promise<CompositeRating | null> {
  const bars = await getYahooHistory(ticker);
  if (!bars) return null;

  // Pull cached meta + news in parallel — both can fail independently
  // without blocking the composite.
  const [meta, news] = await Promise.all([
    readChartMeta(ticker).catch(() => null),
    getYahooNews(ticker).catch(() => null),
  ]);

  const breakdown: CompositeBreakdown = {
    rsi:       rsiSignal(bars),
    sma:       smaCrossSignal(bars),
    momentum:  momentumSignal(bars, meta?.high52w),
    volume:    volumeSignal(bars),
    sentiment: sentimentSignal(news ?? []),
  };

  return composeRating(ticker, breakdown);
}
