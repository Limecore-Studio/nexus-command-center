// ─── v1.2 Insights rating history + tier-change notifications ───────────
//
// Installed as a side-effect observer on useInsightsStore. Every time a
// rating is computed:
//   1. Persist the result into Dexie's `ratingHistory` table.
//   2. Compare new tier vs. previous tier for this ticker. If the tier
//      changed by >= 1 step (e.g. Hold → Buy, or Buy → Strong Buy) AND we
//      haven't notified for this ticker in the last 48h, schedule a push.
//
// Why a 48h cooldown? Yahoo's history (and our signals derived from it)
// updates daily; a volatile ticker that oscillates around a tier boundary
// would otherwise pinball back and forth, spamming the user. 48h is a soft
// rate limit — long enough to dampen oscillation, short enough that a real
// regime change still surfaces within the same trading week.
//
// Notification routing: tap goes to /finance/insights so the user can see
// the full breakdown context. The pill colors on rows there mirror the
// in-notification "X is now Y" line.

import { db } from '../db/database';
import { installRatingObserver } from '../store/useInsightsStore';
import { scheduleNotification, ID_RANGES } from './notifications';
import { TIER_LABEL, TIER_STEP } from './insightTiers';
import type { CompositeRating } from './insightsScore';

const COOLDOWN_MS = 48 * 60 * 60 * 1000;

/** Stable 32-bit hash of a ticker → notification ID within the insights range. */
function tickerToNotificationId(ticker: string): number {
  let h = 5381;
  for (let i = 0; i < ticker.length; i++) {
    h = ((h << 5) + h + ticker.charCodeAt(i)) | 0;
  }
  const range = ID_RANGES.insights;
  return range.base + (Math.abs(h) % range.size);
}

// In-memory cache of the last notification time per ticker. Lives for the
// session; on cold start we hydrate from the most-recent history entries so
// the cooldown survives app restart (otherwise a quick foreground after an
// EoD alarm would re-fire the same tier-change push).
//
// Stored as ticker → ISO timestamp of the LAST notification we sent (NOT
// the last rating computed — those happen on every recompute).
const lastNotifiedAt = new Map<string, string>();
const LAST_NOTIFIED_KEY = 'nexus.insights.lastNotifiedAt';

function loadLastNotified(): void {
  try {
    const raw = localStorage.getItem(LAST_NOTIFIED_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Record<string, string>;
    for (const [k, v] of Object.entries(parsed)) lastNotifiedAt.set(k, v);
  } catch { /* ignore */ }
}

function saveLastNotified(): void {
  try {
    const obj: Record<string, string> = {};
    for (const [k, v] of lastNotifiedAt) obj[k] = v;
    localStorage.setItem(LAST_NOTIFIED_KEY, JSON.stringify(obj));
  } catch { /* ignore quota */ }
}

async function persistHistoryEntry(rating: CompositeRating): Promise<void> {
  try {
    await db.ratingHistory.add({
      id: `${rating.ticker}:${rating.computedAt}`,
      ticker: rating.ticker,
      computedAt: rating.computedAt,
      score: rating.score,
      tier: rating.tier,
      breakdownJson: JSON.stringify(rating.breakdown),
    });
  } catch (e) {
    // ConstraintError on duplicate ID is fine — same-millisecond recomputes
    // are rare enough that we just swallow it.
    if ((e as Error).name !== 'ConstraintError') {
      console.warn('[insights] history write failed:', (e as Error).message);
    }
  }
}

/** Decide whether the new rating warrants a tier-change push. Returns the
 *  notification body string when yes, null when no. */
function buildTierChangeBody(
  rating: CompositeRating,
  prev: CompositeRating | null,
): string | null {
  if (!prev) return null;
  const stepDelta = TIER_STEP[rating.tier] - TIER_STEP[prev.tier];
  if (Math.abs(stepDelta) < 1) return null; // same tier
  const direction = stepDelta > 0 ? '↑' : '↓';
  return `${prev.tier !== rating.tier ? `${TIER_LABEL[prev.tier]} → ${TIER_LABEL[rating.tier]}` : ''} ${direction}`.trim();
}

async function maybeNotifyTierChange(
  rating: CompositeRating,
  prev: CompositeRating | null,
): Promise<void> {
  const body = buildTierChangeBody(rating, prev);
  if (!body) return;
  // 48h cooldown per ticker.
  const last = lastNotifiedAt.get(rating.ticker);
  if (last && Date.now() - new Date(last).getTime() < COOLDOWN_MS) return;

  const result = await scheduleNotification({
    id: tickerToNotificationId(rating.ticker),
    category: 'insights',
    title: `${rating.ticker} · ${TIER_LABEL[rating.tier]}`,
    body,
    // No `at` — fires immediately (current behavior of scheduleNotification
    // when at is omitted).
    extra: { route: '/finance/insights', ticker: rating.ticker },
  });
  if (result.ok) {
    lastNotifiedAt.set(rating.ticker, new Date().toISOString());
    saveLastNotified();
  }
}

/**
 * Install the rating observer on the Insights store. Idempotent — calling
 * twice replaces the previous observer (which is itself). Mount this once
 * at app init.
 */
export function installRatingHistory(): void {
  loadLastNotified();
  installRatingObserver((rating, prev) => {
    // Fire-and-forget. Both are independent — history write can fail without
    // blocking the notification, and vice versa.
    void persistHistoryEntry(rating);
    void maybeNotifyTierChange(rating, prev);
  });
}

