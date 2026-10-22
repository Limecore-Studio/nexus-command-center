// ─── NCC v1.2 Insights store ────────────────────────────────────────────
//
// Holds the latest TECHNICAL and FUNDAMENTAL composite ratings per ticker
// plus a tiered recompute scheduler.
//
// Tiering (driven by lib/insightsCache.ts):
//   - Technical recompute   → runs once per calendar day per ticker
//   - Fundamental recompute → runs once per week per ticker
//   - Quote refresh         → handled by useFinanceStore.refreshPortfolio
//     on the existing 60s soft floor + 20min resume tick (not this store).
//
// The store IDs each recompute pass against a localStorage timestamp so
// repeated cold-starts within the tier window short-circuit without
// re-iterating the signal math. Underlying Dexie caches would have served
// every input anyway; skipping the JS-side iteration saves a non-trivial
// amount of mainline thread time on a 15-ticker portfolio.
//
// Why a separate store (not folded into useFinanceStore)?
//   - Insights computation is i/o + cpu heavy. Folded into the global
//     finance store, every selector would re-render on every rating change.
//   - The rating history (Dexie ratingHistory table) hangs off this store's
//     recompute pipeline; useFinanceStore has no reason to know about that.
//
// Persistence: BUG-9 (2026-06-06) — composite ratings now persist to a
// Dexie `insightsScores` table (one row per ticker+kind, upserted after
// every successful recompute) AND hydrate on cold start via `hydrate()`.
// Pre-fix this store was memory-only: the tier-sweep guard in
// `lib/insightsCache.ts` would correctly short-circuit on a warm-window
// cold start, but the in-memory maps were empty so the UI showed blank
// pills until the user manually hit Refresh.
// Tier history (for tier-change notifications) ALSO persists via the
// `ratingObserver` hook installed by lib/ratingHistory.ts — that's a
// separate chronological log used for cooldown, not for rehydration.

import { create } from 'zustand';
import type { CompositeRating } from '../lib/insightsScore';
import type { FundamentalRating } from '../lib/fundamentalsScore';
// v1.18.2 — the scoring engines (signals, Yahoo history/news, fundamentals)
// load on the first sweep instead of with the app. Hydrating stored ratings at
// start-up doesn't need them; only computing a fresh one does.
async function computeInsightForTicker(ticker: string): Promise<CompositeRating | null> {
  return (await import('../lib/insightsScore')).computeInsightForTicker(ticker);
}
async function computeFundamentalForTicker(ticker: string): Promise<FundamentalRating | null> {
  return (await import('../lib/fundamentalsScore')).computeFundamentalForTicker(ticker);
}
import {
  shouldRunDailyTechnicalSweep,
  markDailyTechnicalSweep,
  shouldRunWeeklyFundamentalSweep,
  markWeeklyFundamentalSweep,
  saveInsightScore,
  hydrateInsightScores,
} from '../lib/insightsCache';
import { useFinanceStore } from './useFinanceStore';

interface InsightsStore {
  /** Technical ratings keyed by uppercase ticker. */
  ratings: Record<string, CompositeRating>;
  /** Fundamental ratings keyed by uppercase ticker. */
  fundamentals: Record<string, FundamentalRating>;
  /** ISO timestamp of the last successful technical recompute pass. */
  lastRecomputedAt: string | null;
  /** ISO timestamp of the last successful fundamental recompute pass. */
  lastFundamentalAt: string | null;
  /** True while either recompute pass is in flight. */
  loading: boolean;
  /** True specifically while the fundamental pass is in flight (used by UI
   *  to disable the toggle so the user doesn't see a half-empty tab). */
  loadingFundamentals: boolean;
  /** Diagnostic: tickers that failed during the most recent pass. */
  failedTickers: string[];
  failedFundamentalTickers: string[];

  /** Recompute the full universe (portfolio + watchlist) technical signals.
   *  Gated by `shouldRunDailyTechnicalSweep` — pass `{ force: true }` for
   *  a user-triggered manual refresh that bypasses the daily window. */
  recomputeAll: (opts?: { force?: boolean }) => Promise<void>;
  /** Recompute one ticker's technical signals. Used by manual refresh on a
   *  holding detail sheet. Not tier-gated — the user explicitly asked. */
  recomputeOne: (ticker: string) => Promise<void>;

  /** Recompute fundamentals for the full universe. Gated weekly. */
  recomputeFundamentalsAll: (opts?: { force?: boolean }) => Promise<void>;
  /** Recompute one ticker's fundamentals. Not tier-gated. */
  recomputeFundamentalOne: (ticker: string) => Promise<void>;

  /** Look up a technical rating by ticker (case-insensitive). */
  getRating: (ticker: string) => CompositeRating | null;
  /** Look up a fundamental rating by ticker (case-insensitive). */
  getFundamental: (ticker: string) => FundamentalRating | null;

  /** BUG-9 — pull persisted ratings + fundamentals from the
   *  `insightsScores` Dexie table into in-memory maps. Called once from
   *  AppShell's initial Promise.all so the maps are populated BEFORE the
   *  cold-start refresh effect kicks the recompute pipelines. Subsequent
   *  recomputes overwrite both disk and memory. Idempotent — safe to call
   *  more than once though there's no reason to. */
  hydrate: () => Promise<void>;
}

// Optional observer for tier-change side effects (Dexie history + push).
// The library/notification module wires itself in via installRatingObserver;
// the store stays decoupled.
type RatingObserver = (rating: CompositeRating, prev: CompositeRating | null) => void;
let ratingObserver: RatingObserver | null = null;
export function installRatingObserver(fn: RatingObserver | null): void {
  ratingObserver = fn;
}

let recomputingTechnical = false;
let recomputingFundamental = false;

/** Walk the portfolio + watchlist for unique stock/etf tickers. Crypto, fx
 *  and cash are intentionally excluded — the signal engines aren't tuned
 *  for them and Yahoo's coverage is patchy. */
function collectInsightUniverse(): string[] {
  const fin = useFinanceStore.getState();
  const set = new Set<string>();
  for (const h of fin.holdings) {
    if (h.assetType === 'stock' || h.assetType === 'etf') set.add(h.ticker.toUpperCase());
  }
  for (const w of fin.watchlist) {
    if (w.assetType === 'stock' || w.assetType === 'etf') set.add(w.ticker.toUpperCase());
  }
  return Array.from(set);
}

export const useInsightsStore = create<InsightsStore>((set, get) => ({
  ratings: {},
  fundamentals: {},
  lastRecomputedAt: null,
  lastFundamentalAt: null,
  loading: false,
  loadingFundamentals: false,
  failedTickers: [],
  failedFundamentalTickers: [],

  async recomputeAll(opts) {
    if (recomputingTechnical) return;
    // Tier guard — skip when the daily window hasn't elapsed. The user's
    // manual refresh path passes force=true to bypass.
    if (!shouldRunDailyTechnicalSweep(opts?.force ?? false)) return;
    recomputingTechnical = true;
    set({ loading: true, failedTickers: [] });
    try {
      const tickers = collectInsightUniverse();
      const failed: string[] = [];
      // Sequential — each Yahoo history call is rate-gated; parallel bursts
      // would trip the 60/min limit. Worst-case walltime ~12s for a 15-ticker
      // portfolio on a cold cache; UI shows loading state.
      const next: Record<string, CompositeRating> = { ...get().ratings };
      for (const t of tickers) {
        try {
          const rating = await computeInsightForTicker(t);
          if (rating) {
            const prev = next[t] ?? null;
            next[t] = rating;
            if (ratingObserver) {
              try { ratingObserver(rating, prev); } catch (e) {
                console.warn('[insights] observer threw for', t, e);
              }
            }
            // BUG-9 — persist after the observer runs so the rating-history
            // log + score-snapshot upsert stay roughly in sync. Awaited so
            // a slow IndexedDB write doesn't stack behind the next
            // ticker's compute; saveInsightScore swallows its own errors
            // so this never throws.
            await saveInsightScore('technical', rating);
          } else {
            failed.push(t);
          }
        } catch (e) {
          console.warn('[insights] recompute failed for', t, e);
          failed.push(t);
        }
      }
      set({
        ratings: next,
        lastRecomputedAt: new Date().toISOString(),
        loading: false,
        failedTickers: failed,
      });
      // v1.2 code-review #2 — mark sweep complete when at least one ticker
      // succeeded OR the universe is empty (no work to do is a successful
      // sweep, not a failed one). Previous `failed.length < tickers.length`
      // gate made `0 < 0` false on empty portfolios → cold-start re-iterated
      // forever.
      if (tickers.length === 0 || failed.length < tickers.length) {
        markDailyTechnicalSweep();
      }
    } finally {
      recomputingTechnical = false;
    }
  },

  async recomputeOne(ticker) {
    const upper = ticker.toUpperCase();
    try {
      const rating = await computeInsightForTicker(upper);
      if (rating) {
        const prev = get().ratings[upper] ?? null;
        set({ ratings: { ...get().ratings, [upper]: rating } });
        if (ratingObserver) {
          try { ratingObserver(rating, prev); } catch (e) {
            console.warn('[insights] observer threw for', upper, e);
          }
        }
        // BUG-9 — persist on the single-ticker manual refresh path too.
        await saveInsightScore('technical', rating);
      }
    } catch (e) {
      console.warn('[insights] recomputeOne failed for', upper, e);
    }
  },

  async recomputeFundamentalsAll(opts) {
    if (recomputingFundamental) return;
    if (!shouldRunWeeklyFundamentalSweep(opts?.force ?? false)) return;
    recomputingFundamental = true;
    set({ loadingFundamentals: true, failedFundamentalTickers: [] });
    try {
      const tickers = collectInsightUniverse();
      const failed: string[] = [];
      const next: Record<string, FundamentalRating> = { ...get().fundamentals };
      // Sequential — fundamentals call 3-4 Finnhub endpoints per ticker;
      // parallel bursts would hammer the 60/min cap. With 7d Dexie TTLs
      // most calls are cache hits on warm starts.
      for (const t of tickers) {
        try {
          const rating = await computeFundamentalForTicker(t);
          if (rating) {
            next[t] = rating;
            // BUG-9 — persist after every successful per-ticker compute.
            // Fundamentals don't have an observer wired (no tier-change
            // notifications for the weekly cadence), so this is the only
            // disk-write site for the fundamental tab.
            await saveInsightScore('fundamental', rating);
          } else {
            failed.push(t);
          }
        } catch (e) {
          console.warn('[insights] fundamental recompute failed for', t, e);
          failed.push(t);
        }
      }
      set({
        fundamentals: next,
        lastFundamentalAt: new Date().toISOString(),
        loadingFundamentals: false,
        failedFundamentalTickers: failed,
      });
      // Same empty-portfolio guard as the technical sweep (code-review #2).
      if (tickers.length === 0 || failed.length < tickers.length) {
        markWeeklyFundamentalSweep();
      }
    } finally {
      recomputingFundamental = false;
    }
  },

  async recomputeFundamentalOne(ticker) {
    const upper = ticker.toUpperCase();
    try {
      const rating = await computeFundamentalForTicker(upper);
      if (rating) {
        set({ fundamentals: { ...get().fundamentals, [upper]: rating } });
        // BUG-9 — persist on the single-ticker manual refresh path too.
        await saveInsightScore('fundamental', rating);
      }
    } catch (e) {
      console.warn('[insights] fundamental recomputeOne failed for', upper, e);
    }
  },

  getRating(ticker) {
    return get().ratings[ticker.toUpperCase()] ?? null;
  },

  getFundamental(ticker) {
    return get().fundamentals[ticker.toUpperCase()] ?? null;
  },

  async hydrate() {
    // BUG-9 — pull persisted ratings into memory on cold start. Merges with
    // (rather than replaces) the current maps so a recompute that lands
    // mid-hydration isn't overwritten by stale disk data. In practice this
    // races only with the single-ticker manual-refresh path, since the
    // bulk recompute pipelines wait for hydrate() via AppShell's
    // Promise.all.
    const { ratings, fundamentals } = await hydrateInsightScores();
    set({
      ratings:      { ...ratings,      ...get().ratings      },
      fundamentals: { ...fundamentals, ...get().fundamentals },
    });
  },
}));
