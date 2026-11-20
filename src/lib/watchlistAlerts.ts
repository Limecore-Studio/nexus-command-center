// Watchlist price-target alerts (v1.15 Item 9).
//
// The targets themselves are old: `targetAbove`/`targetBelow` have been on
// WatchlistItem, editable in Watchlist.tsx and synced to `watchlist_items`
// since the watchlist shipped, and the row already shows a "Target ≥ hit"
// badge. What never existed was the notification, so a target only told you
// anything if you happened to open the Watchlist while it was crossed.
//
// Same shape as budgetAlerts.ts: a threshold check plus a localStorage tracker.
//
// Runs:
//   • after every refreshPortfolio (useFinanceStore), which is the only place
//     watchlist quotes change. That includes the cold-start and resume
//     refreshes, so unlike budgetAlerts there is no separate AppShell call:
//     before the first refresh there are no quotes to compare against.
//   • when the Settings toggle is flipped on
//
// De-dupe:
//   localStorage key  nexus.notif.watch.<itemId>
//   value             "above:<target>" | "below:<target>"
//
//   Once a side has fired for a given target it stays quiet while the price
//   stays past it. When the price comes back inside the band the tracker is
//   wiped, so a later re-cross fires again (budgetAlerts' rule, for the same
//   reason). The target value is part of the stored string, so editing a
//   target re-arms it without anyone having to clear anything.
//
// Notification IDs live in 6000-6099: one slot per item by hash, side in the
// LSB. A collision only means one pending alarm replaces another; the tracker,
// not the ID, decides whether an alert has been sent.

import type { WatchlistItem } from '../types/finance';
import type { CryptoResult } from '../api/coingecko';
import type { QuoteResult } from '../api/finnhub';
import { convertSync, normalizeCurrency } from '../api/fxRates';
import { useFinanceStore } from '../store/useFinanceStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { ID_RANGES, scheduleNotification } from './notifications';
import { hashSlot, slotAllocator } from './notifSlots';

export type TargetSide = 'above' | 'below';

export interface WatchPrice {
  price: number | null;
  currency: string;
  dayPct: number;
}

/**
 * The price a watchlist row shows, in base currency where FX allows and in
 * the quote's native currency where it does not. Shared by the Watchlist
 * screen and the alert tick so the badge and the notification can never
 * disagree about whether a target was hit.
 */
export function resolveWatchPrice(
  w: WatchlistItem,
  stockQuotes: QuoteResult[],
  cryptoPrices: CryptoResult | null,
  fxRates: Record<string, number> | null,
  baseCurrency: string,
): WatchPrice {
  if (w.assetType === 'crypto') {
    const p = cryptoPrices?.prices.find((x) => x.id === w.ticker.toLowerCase());
    if (!p) return { price: null, currency: baseCurrency, dayPct: 0 };
    const conv = baseCurrency === 'EUR' ? p.priceEur : convertSync(p.priceEur, 'EUR', baseCurrency, fxRates);
    return { price: conv, currency: baseCurrency, dayPct: p.change24h ?? 0 };
  }
  const q = stockQuotes.find((s) => s.ticker === w.ticker.toUpperCase());
  if (!q) return { price: null, currency: baseCurrency, dayPct: 0 };
  const native = normalizeCurrency(q.quote.c, q.currency);
  const conv = convertSync(q.quote.c, q.currency, baseCurrency, fxRates);
  return {
    price: conv ?? native.amount,
    currency: conv != null ? baseCurrency : native.currency,
    dayPct: q.quote.dp ?? 0,
  };
}

/** Which target, if either, the price is past. Above wins if both are. */
export function targetHit(w: WatchlistItem, price: number | null): TargetSide | null {
  if (price == null) return null;
  if (w.targetAbove != null && price >= w.targetAbove) return 'above';
  if (w.targetBelow != null && price <= w.targetBelow) return 'below';
  return null;
}

function trackerKey(itemId: string): string {
  return `nexus.notif.watch.${itemId}`;
}

// v1.22 (NCC#258): a slot per item assigned on this device
// (lib/notifSlots.ts), not a hash that let one item's alert replace
// another's. Past the range's size, the hash.
const WATCH_SLOTS = ID_RANGES.watchlist.size / 2;
const watchSlots = slotAllocator('watchlist.alertSlots', WATCH_SLOTS);
async function watchNotifId(itemId: string, side: TargetSide): Promise<number> {
  const slot = (await watchSlots.slotOf(itemId)) ?? hashSlot(itemId, WATCH_SLOTS);
  return ID_RANGES.watchlist.base + slot * 2 + (side === 'above' ? 0 : 1);
}

function formatPrice(n: number): string {
  // Sub-unit prices (most altcoins) need significant figures, not decimals.
  return n >= 1 ? n.toFixed(2) : n.toPrecision(3);
}

/**
 * Compare every watched ticker's current price against its targets and
 * notify once per crossing. Idempotent and fire-and-forget: errors are
 * logged, never thrown, so a plugin failure cannot break a refresh.
 */
export async function runWatchlistAlertsTick(): Promise<void> {
  const settings = useSettingsStore.getState();
  if (!settings.notifMasterEnabled) return;
  if (!settings.notifWatchlistEnabled) return;

  const { watchlist, stockQuotes, cryptoPrices, fxRates } = useFinanceStore.getState();

  for (const w of watchlist) {
    const key = trackerKey(w.id);
    if (w.targetAbove == null && w.targetBelow == null) {
      if (localStorage.getItem(key)) localStorage.removeItem(key);
      continue;
    }

    const { price, currency } = resolveWatchPrice(w, stockQuotes, cryptoPrices, fxRates, settings.baseCurrency);
    // No quote this round: say nothing and keep the tracker. Wiping it here
    // would re-fire an alert the user already has as soon as a flaky
    // provider comes back.
    if (price == null) continue;
    // Targets are entered in base currency. A native-currency fallback price
    // (FX unavailable) is not comparable to them, and an alert on that
    // comparison would be a false one, so skip rather than guess.
    if (currency !== settings.baseCurrency) continue;

    const side = targetHit(w, price);
    if (!side) {
      if (localStorage.getItem(key)) localStorage.removeItem(key);
      continue;
    }

    const target = side === 'above' ? w.targetAbove! : w.targetBelow!;
    const marker = `${side}:${target}`;
    if (localStorage.getItem(key) === marker) continue;

    try {
      const result = await scheduleNotification({
        id: await watchNotifId(w.id, side),
        category: 'watchlist',
        title: `${w.ticker.toUpperCase()} ${side === 'above' ? '≥' : '≤'} ${formatPrice(target)} ${currency}`,
        body: `${w.name}: ${formatPrice(price)} ${currency}`,
        extra: { route: '/finance/portfolio/watchlist' },
      });
      if (result.ok) localStorage.setItem(key, marker);
    } catch (e) {
      console.warn('[watchlistAlerts]', w.ticker, (e as Error).message);
    }
  }
}
