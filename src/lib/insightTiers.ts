// v1.18.2 — the Insights tier names and steps, on their own.
//
// They used to live only in insightsScore.ts, so anything that needed a label
// (ratingHistory at start-up, RatingPill) pulled in the whole scoring engine
// with its signals and the Yahoo fundamentals client — about 17 KiB of the
// startup chunk for two small tables. insightsScore re-exports them unchanged.

export type InsightTier =
  | 'strong_buy'
  | 'buy'
  | 'hold'
  | 'sell'
  | 'strong_sell';

export const TIER_LABEL: Record<InsightTier, string> = {
  strong_buy:  'Strong Buy',
  buy:         'Buy',
  hold:        'Hold',
  sell:        'Sell',
  strong_sell: 'Strong Sell',
};

/** Tier-step distance — used by the tier-change notification to gate on
 *  ≥1 step jumps. Strong tiers are 2 steps from neutral. */
export const TIER_STEP: Record<InsightTier, number> = {
  strong_sell: -2,
  sell:        -1,
  hold:         0,
  buy:          1,
  strong_buy:   2,
};
