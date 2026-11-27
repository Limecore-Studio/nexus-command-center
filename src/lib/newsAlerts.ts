// News-driven notifications.
//
// Three sources of alerts, scored by relevance:
//
//   HIGH   — news items tagged with a ticker the user owns (from
//            useFinanceStore.companyNews). Always alerted when News is on.
//
//   MEDIUM — market news whose headline matches one of the macro-event
//            keywords (Fed, CPI, jobs report, etc.). Off by default; the
//            user opts in via Settings → "Include Macro Headlines".
//
//   SYNTHETIC — a market-move alert when SPY or QQQ moves ≥1.5% today.
//            One per day max (tracked by local date). This catches the case
//            where the market did something big but the matching headline
//            isn't worded for our keyword filter.
//
// De-dup strategy:
//
//   localStorage  nexus.notif.news.seen
//                 JSON array of `h:<id>|<url>` and `m:<id>|<url>` keys,
//                 capped at 200 (FIFO).
//
//   Once a key is in seen, we never fire its notification again. If we hit
//   the per-tick cap (MAX_PER_TICK = 5) we STILL mark the surplus items as
//   seen so a later refresh doesn't re-fire them when slots free up — a
//   trade-off that favors quiet over completeness.
//
// ID mapping: news ID is a number from the API (Finnhub article IDs or
// our Yahoo-derived synthetic IDs). Hash into the 5000-5999 slot range.
// Two different items can collide to the same notif ID; in practice the
// later one overwrites the earlier-but-not-yet-tapped one which is
// acceptable for transient news alerts.

import { useFinanceStore } from '../store/useFinanceStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { ID_RANGES, scheduleNotification } from './notifications';
import type { NewsItem } from '../api/stockDetail';
import i18n from '../i18n';
import { formatLocale } from '../utils/formatters';

const NEWS_BASE = ID_RANGES.news.base; // 5000
const BIG_MOVE_ID = ID_RANGES.news.base + ID_RANGES.news.size - 1; // 5999 — top of range
const SEEN_KEY = 'nexus.notif.news.seen';
const SEEN_CAP = 200;
const MAX_PER_TICK = 5;
// Index move threshold. The user's design call: ≥1.5% intraday OR ≥2% close.
// We collapse to a single 1.5% threshold throughout the day — the once-per-day
// localStorage tracker prevents re-firing the same alert during a sustained
// move, and the value already passed 1.5% by the time we'd notify at close.
const BIG_MOVE_THRESHOLD_PCT = 1.5;
const BIG_MOVE_LAST_KEY = 'nexus.notif.news.lastBigMoveDate';

// Macro-event keyword set. Lowercased for case-insensitive substring matching.
// Curated to cover the events that move broad markets without dragging in
// company-specific noise (where the HIGH-priority owned-ticker path catches
// what matters anyway).
const MACRO_KEYWORDS = [
  'fed ', 'fomc', 'cpi', 'inflation', 'jobs report', 'unemployment',
  'rate hike', 'rate cut', 'recession', 'gdp', 'powell',
  // Trailing/leading spaces on "fed " avoid false positives like
  // "federation", "feeding".
];

function loadSeen(): Set<string> {
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr.map(String) : []);
  } catch {
    return new Set();
  }
}

function persistSeen(seen: Set<string>): void {
  const arr = [...seen].slice(-SEEN_CAP);
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(arr));
  } catch {
    /* quota — drop silently */
  }
}

function newsNotifId(itemId: number, salt: number): number {
  // Mix the salt into the hash so HIGH and MEDIUM items with the same
  // underlying ID (extremely unlikely but possible across providers) land
  // in different slots and don't fight over the same alarm.
  const mixed = (itemId * 2654435761 + salt * 16807) | 0;
  const slot = Math.abs(mixed) % (ID_RANGES.news.size - 1); // reserve 5999 for big-move
  return NEWS_BASE + slot;
}

function matchesMacroKeywords(headline: string): boolean {
  const h = ' ' + headline.toLowerCase() + ' ';
  return MACRO_KEYWORDS.some((kw) => h.includes(kw));
}

function todayLocalDate(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Score, filter, and schedule notifications for fresh news + index moves.
 *
 * Called from refreshPortfolio after news + quotes have been written into
 * the store. Idempotent — the localStorage tracker prevents re-firing the
 * same item across calls.
 *
 * No-ops when:
 *   • News notification toggle is off
 *   • There's nothing new to alert about
 *
 * The function is intentionally fire-and-forget at the call site so a
 * notification failure can't block the surrounding refresh from settling.
 */
export async function runNewsAlertsTick(): Promise<void> {
  const settings = useSettingsStore.getState();
  if (!settings.notifMasterEnabled) return;
  if (!settings.notifNewsEnabled) return;

  const state = useFinanceStore.getState();
  const seen = loadSeen();
  let scheduled = 0;

  // ─── HIGH: owned-ticker news ──────────────────────────────────────────
  const ownedTickers = new Set(
    state.holdings
      .filter((h) => h.assetType === 'stock' || h.assetType === 'etf')
      .map((h) => h.ticker.toUpperCase()),
  );

  const highCandidates: Array<{ ticker: string; item: NewsItem }> = [];
  for (const ticker of ownedTickers) {
    const items = state.companyNews[ticker] ?? [];
    for (const item of items) {
      const key = `h:${item.id}|${item.url}`;
      if (seen.has(key)) continue;
      highCandidates.push({ ticker, item });
    }
  }
  // Newest first so the cap (MAX_PER_TICK) doesn't waste slots on stale news.
  highCandidates.sort((a, b) => b.item.datetime - a.item.datetime);

  for (const { ticker, item } of highCandidates) {
    const key = `h:${item.id}|${item.url}`;
    if (scheduled >= MAX_PER_TICK) {
      // Still mark as seen so the slot doesn't free up later and re-fire
      // a stale alert when companyNews next refreshes.
      seen.add(key);
      continue;
    }
    try {
      const result = await scheduleNotification({
        id: newsNotifId(item.id, 0),
        category: 'news',
        title: `${ticker} · ${item.source}`,
        body: item.headline.slice(0, 200),
        extra: { route: '/finance?tab=portfolio', url: item.url },
      });
      if (result.ok) {
        seen.add(key);
        scheduled++;
      }
    } catch (e) {
      console.warn('[newsAlerts] HIGH schedule', (e as Error).message);
    }
  }

  // ─── MEDIUM: macro-keyword market news (opt-in) ───────────────────────
  if (settings.notifMacroKeywordsEnabled) {
    const macroCandidates = state.marketNews
      .filter(
        (n) =>
          !seen.has(`m:${n.id}|${n.url}`) && matchesMacroKeywords(n.headline),
      )
      .sort((a, b) => b.datetime - a.datetime);

    for (const item of macroCandidates) {
      const key = `m:${item.id}|${item.url}`;
      if (scheduled >= MAX_PER_TICK) {
        seen.add(key);
        continue;
      }
      try {
        const result = await scheduleNotification({
          id: newsNotifId(item.id, 1),
          category: 'news',
          title: i18n.t('notif.news.market', { source: item.source }),
          body: item.headline.slice(0, 200),
          extra: { route: '/finance?tab=portfolio', url: item.url },
        });
        if (result.ok) {
          seen.add(key);
          scheduled++;
        }
      } catch (e) {
        console.warn('[newsAlerts] MEDIUM schedule', (e as Error).message);
      }
    }
  }

  // ─── SYNTHETIC: SPY/QQQ ±1.5% market-move alert (once per day) ────────
  const spy = state.stockQuotes.find((q) => q.ticker === 'SPY');
  const qqq = state.stockQuotes.find((q) => q.ticker === 'QQQ');
  const movers = [spy, qqq]
    .filter((q): q is NonNullable<typeof q> => !!q)
    .map((q) => ({ ticker: q.ticker, dp: q.quote.dp ?? 0 }))
    .filter((m) => Math.abs(m.dp) >= BIG_MOVE_THRESHOLD_PCT);

  if (movers.length > 0) {
    const today = todayLocalDate();
    const lastFired = localStorage.getItem(BIG_MOVE_LAST_KEY);
    if (lastFired !== today) {
      // Pick the most extreme mover for the headline.
      const top = movers.sort((a, b) => Math.abs(b.dp) - Math.abs(a.dp))[0];
      try {
        const result = await scheduleNotification({
          id: BIG_MOVE_ID,
          category: 'news',
          title: i18n.t('notif.news.moveTitle'),
          body: i18n.t('notif.news.moveBody', {
            ticker: top.ticker,
            pct: new Intl.NumberFormat(formatLocale(), { style: 'percent', minimumFractionDigits: 2, maximumFractionDigits: 2, signDisplay: 'always' })
              .format(top.dp / 100),
          }),
          extra: { route: '/finance?tab=portfolio' },
        });
        if (result.ok) {
          localStorage.setItem(BIG_MOVE_LAST_KEY, today);
        }
      } catch (e) {
        console.warn('[newsAlerts] big-move schedule', (e as Error).message);
      }
    }
  }

  persistSeen(seen);
}
