// Yahoo Finance Chart API — undocumented but widely used. Free, no key, supports
// international exchanges (London .L, Helsinki .HE, Stockholm .ST, Frankfurt .DE, etc.)
// where Finnhub's free tier only covers US stocks.
//
// On Android (native Capacitor) we call CapacitorHttp.request() directly to
// bypass WebView CORS — Yahoo's endpoint doesn't ship browser-friendly CORS
// headers. On web (dev preview) we use axios; CORS will fail there but the
// data is non-essential in dev.
//
// IMPORTANT: Yahoo now rejects requests without a real-looking User-Agent
// (returns 401/403/empty), which was silently breaking refresh and leaving
// the cache permanently stale. We send a desktop Chrome UA + Accept-Language.

import { loadAxios } from './http';
import { Capacitor } from '@capacitor/core';
import { CapacitorHttp } from '@capacitor/core';
import type { FinnhubQuote } from './finnhub';
import { readCache, writeCache, shouldFetch, recordCall } from './cache';

// Native (Android): hit Yahoo directly via CapacitorHttp which bypasses
// the WebView CORS check. Web dev preview: go through the Vite proxy at
// /yfin (configured in vite.config.ts). Yahoo refuses cross-origin XHR
// from localhost so without the proxy every dev fetch fails with the
// generic "Network Error" axios message.
const BASE_URL = Capacitor.isNativePlatform()
  ? 'https://query1.finance.yahoo.com/v8/finance/chart'
  : '/yfin/v8/finance/chart';

const BROWSER_HEADERS: Record<string, string> = {
  Accept: 'application/json, text/javascript, */*; q=0.01',
  'Accept-Language': 'en-US,en;q=0.9',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
};

// Same headers minus User-Agent — browsers refuse to set that header on XHR
// and emit "Refused to set unsafe header" warnings on every call. The UA is
// only needed on the native CapacitorHttp path (Yahoo 401s without a real-
// looking UA there). In the web fallback the browser sets its own UA anyway.
const WEB_HEADERS: Record<string, string> = Object.fromEntries(
  Object.entries(BROWSER_HEADERS).filter(([k]) => k.toLowerCase() !== 'user-agent'),
);

interface YahooChartResponse {
  chart?: {
    result?: Array<{
      meta?: {
        regularMarketPrice?: number;
        chartPreviousClose?: number;
        previousClose?: number;
        regularMarketDayHigh?: number;
        regularMarketDayLow?: number;
        regularMarketOpen?: number;
        regularMarketTime?: number;
        currency?: string;
        // Extra fields Yahoo's chart endpoint also returns. Useful as a
        // no-auth fallback for getYahooMetric: we get 52w range, exchange,
        // and the company's display name without needing a crumb.
        fiftyTwoWeekHigh?: number;
        fiftyTwoWeekLow?: number;
        regularMarketVolume?: number;
        exchangeName?: string;
        fullExchangeName?: string;
        instrumentType?: string;
        longName?: string;
        shortName?: string;
      };
      // For range=5d/7d/1mo + interval=1d|1h.
      timestamp?: number[];
      indicators?: {
        quote?: Array<{
          close?: (number | null)[];
          // v1.2 — volume series for Insights' volume-pressure signal. Yahoo
          // emits null gaps for missing bars; the consumer filters them out.
          volume?: (number | null)[];
        }>;
      };
    }>;
    error?: unknown;
  };
}

// Partial metric/profile snapshot derived from a /chart call's `meta` object.
// Written opportunistically by getYahooQuote so getYahooMetric can use it as
// a fallback when quoteSummary is unavailable (e.g. web/CORS or crumb fails).
interface YahooChartMeta {
  ticker: string;
  longName?: string;
  exchange?: string;
  currency?: string;
  high52w?: number;
  low52w?: number;
  fetchedAt: string;
}
const CHART_META_TTL_MS = 24 * 60 * 60 * 1000;
const CHART_META_KEY = (ticker: string) => `yh_chartmeta_${ticker.toUpperCase()}`;

export async function readChartMeta(ticker: string): Promise<YahooChartMeta | null> {
  const { db } = await import('../db/database');
  const entry = await db.apiCache.get(CHART_META_KEY(ticker));
  if (!entry) return null;
  if (Date.now() - new Date(entry.fetchedAt).getTime() > CHART_META_TTL_MS) return null;
  try { return JSON.parse(entry.data) as YahooChartMeta; } catch { return null; }
}

async function writeChartMeta(meta: YahooChartMeta): Promise<void> {
  const { db } = await import('../db/database');
  const now = new Date();
  await db.apiCache.put({
    cacheKey: CHART_META_KEY(meta.ticker),
    data: JSON.stringify(meta),
    fetchedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + CHART_META_TTL_MS).toISOString(),
  });
}

interface YahooCacheEntry {
  quote: FinnhubQuote;
  currency: string;
}

async function fetchYahoo(
  ticker: string,
  params?: Record<string, string>,
): Promise<YahooChartResponse> {
  // Throws on transport failure so the caller can record a specific error
  // (timeout, 401, parse fail) instead of silently returning stale cache.
  const qs = params
    ? '?' + Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')
    : '';
  const url = `${BASE_URL}/${encodeURIComponent(ticker)}${qs}`;
  if (Capacitor.isNativePlatform()) {
    // Native HTTP bypasses CORS entirely.
    const res = await CapacitorHttp.request({
      method: 'GET',
      url,
      headers: BROWSER_HEADERS,
      connectTimeout: 8000,
      readTimeout: 8000,
    });
    if (res.status >= 400) {
      throw new Error(`Yahoo HTTP ${res.status}`);
    }
    // CapacitorHttp returns parsed JSON when Content-Type indicates JSON; if it's
    // a string it might be raw text — handle both.
    const body = res.data;
    if (typeof body === 'string') {
      try {
        return JSON.parse(body) as YahooChartResponse;
      } catch {
        throw new Error('Yahoo returned non-JSON body');
      }
    }
    return body as YahooChartResponse;
  }
  // Web fallback (dev preview only — CORS will likely block this in browser).
  const axios = await loadAxios();
  const { data } = await axios.get<YahooChartResponse>(url, {
    headers: WEB_HEADERS,
    timeout: 8000,
  });
  return data;
}

export interface ProviderError {
  provider: 'finnhub' | 'yahoo' | 'coingecko' | 'fx';
  ticker?: string;
  message: string;
}

// Mutable bucket the store reads after each refresh so the UI can surface
// what actually went wrong (e.g. "Yahoo: 401 Forbidden") instead of the old
// generic "provider rate-limited" message.
export const lastProviderErrors: ProviderError[] = [];

export function clearProviderErrors() {
  lastProviderErrors.length = 0;
}

export async function getYahooQuote(
  ticker: string,
  opts: { force?: boolean } = {},
): Promise<{ quote: FinnhubQuote; currency: string; ageMinutes: number; cached: boolean; stale: boolean } | null> {
  const key = `yahoo_${ticker.toUpperCase()}`;
  const cached = await readCache<YahooCacheEntry>(key);

  // Honor fresh-cache early return unless the caller forces a refresh (the
  // user clicked ↻ — they want a real attempt, not the same cached value).
  if (cached?.fresh && !opts.force) {
    return {
      quote: cached.data.quote,
      currency: cached.data.currency,
      ageMinutes: cached.ageMinutes,
      cached: true,
      stale: false,
    };
  }

  const gate = shouldFetch('yahoo', 'yahoo', { force: opts.force, maxPerMinute: 60, subKey: ticker });
  if (!gate.allow) {
    lastProviderErrors.push({ provider: 'yahoo', ticker, message: gate.reason ?? 'rate-limited' });
    if (cached) {
      return { quote: cached.data.quote, currency: cached.data.currency, ageMinutes: cached.ageMinutes, cached: true, stale: true };
    }
    return null;
  }

  try {
    recordCall('yahoo', 'yahoo', ticker);
    const data = await fetchYahoo(ticker);
    const meta = data?.chart?.result?.[0]?.meta;
    if (!meta || typeof meta.regularMarketPrice !== 'number') {
      const reason = data?.chart?.error
        ? `Yahoo error: ${JSON.stringify(data.chart.error)}`
        : 'Yahoo returned no price';
      lastProviderErrors.push({ provider: 'yahoo', ticker, message: reason });
      console.warn('[yahoo]', ticker, reason);
      if (cached) {
        return { quote: cached.data.quote, currency: cached.data.currency, ageMinutes: cached.ageMinutes, cached: true, stale: true };
      }
      return null;
    }
    const price = meta.regularMarketPrice;
    const prev = meta.chartPreviousClose ?? meta.previousClose ?? price;
    const change = price - prev;
    const changePct = prev !== 0 ? (change / prev) * 100 : 0;
    const quote: FinnhubQuote = {
      c: price,
      d: change,
      dp: changePct,
      h: meta.regularMarketDayHigh ?? price,
      l: meta.regularMarketDayLow ?? price,
      o: meta.regularMarketOpen ?? price,
      pc: prev,
      t: typeof meta.regularMarketTime === 'number' ? meta.regularMarketTime : undefined,
    };
    const currency = meta.currency || 'USD';
    await writeCache(key, { quote, currency });
    // Opportunistically persist the richer chart-meta fields so the
    // fundamentals path has something to render even if quoteSummary fails.
    // Cheap — no extra network call, just one Dexie write per quote.
    await writeChartMeta({
      ticker: ticker.toUpperCase(),
      longName: meta.longName ?? meta.shortName,
      exchange: meta.fullExchangeName ?? meta.exchangeName,
      currency,
      high52w: meta.fiftyTwoWeekHigh,
      low52w: meta.fiftyTwoWeekLow,
      fetchedAt: new Date().toISOString(),
    });
    return { quote, currency, ageMinutes: 0, cached: false, stale: false };
  } catch (e) {
    const msg = (e as Error).message || String(e);
    lastProviderErrors.push({ provider: 'yahoo', ticker, message: msg });
    console.warn('[yahoo]', ticker, msg);
    if (cached) {
      return { quote: cached.data.quote, currency: cached.data.currency, ageMinutes: cached.ageMinutes, cached: true, stale: true };
    }
    return null;
  }
}

// 7-day daily closes for a stock. Cached separately from quotes since the
// TTL differs (a 6h-old sparkline is still informative; a 6h-old quote is
// stale by trading standards). Stored under its own apiCache key.
const SPARKLINE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const SPARKLINE_DEXIE_KEY = (ticker: string) => `yahoo_spark7d_${ticker.toUpperCase()}`;

export async function getYahooSparkline(
  ticker: string,
  opts: { force?: boolean } = {},
): Promise<number[] | null> {
  const dexieKey = SPARKLINE_DEXIE_KEY(ticker);
  // We bypass the standard readCache helper since it bakes in 60min TTL.
  const { db } = await import('../db/database');
  const entry = await db.apiCache.get(dexieKey);
  if (entry && !opts.force) {
    const age = Date.now() - new Date(entry.fetchedAt).getTime();
    if (age < SPARKLINE_TTL_MS) {
      try { return JSON.parse(entry.data) as number[]; } catch { /* fall through */ }
    }
  }
  const gate = shouldFetch('yahoo-spark', 'yahoo', { force: opts.force, maxPerMinute: 60, subKey: ticker });
  if (!gate.allow) return null;
  try {
    recordCall('yahoo-spark', 'yahoo', ticker);
    const data = await fetchYahoo(ticker, { range: '7d', interval: '1d' });
    const result = data?.chart?.result?.[0];
    const closes = result?.indicators?.quote?.[0]?.close;
    if (!closes) return null;
    // Strip null gaps (Yahoo emits null for missing bars).
    const series = closes.filter((x): x is number => typeof x === 'number');
    if (series.length === 0) return null;
    const now = new Date();
    await db.apiCache.put({
      cacheKey: dexieKey,
      data: JSON.stringify(series),
      fetchedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + SPARKLINE_TTL_MS).toISOString(),
    });
    return series;
  } catch (e) {
    console.warn('[yahoo spark]', ticker, (e as Error).message);
    return null;
  }
}

// ─── v1.2 — extended history for Insights signal engine ────────────────────
//
// 6 months at 1d interval gives us enough runway for every signal we compute:
//   - RSI(14) needs 15 closes minimum, comfortable with ~30
//   - 50-day SMA needs 50, comfortable with 60+
//   - 14d + 30d momentum need 30
//   - 20-session volume pressure needs 20
// 6mo / 1d = ~126 bars on US schedules, ample. We cache for 4h since these
// signals are slower-moving than intraday quotes — bursting through Yahoo's
// implicit rate limit on every Insights tab open would be wasteful.

export interface YahooHistoryBar {
  /** Unix seconds (Yahoo's native bar timestamp). */
  t: number;
  close: number;
  volume: number | null;
}

// v1.2 — promoted to Daily tier under the Insights cache architecture
// (`lib/insightsCache.ts`). 24h cache means the technical-signal recompute
// hits the Yahoo chart endpoint at most once per ticker per calendar day,
// regardless of how often the user opens the app.
const HISTORY_TTL_MS = 24 * 60 * 60 * 1000;
const HISTORY_DEXIE_KEY = (ticker: string) => `yh_history_${ticker.toUpperCase()}`;

/**
 * Fetch 6mo of daily history for one ticker — closes + volumes — for the
 * Insights signal engine. Returns null on transport / parse failure or when
 * Yahoo gives us too little data to compute signals (<15 bars).
 *
 * Cache: 4h TTL via Dexie's apiCache table. Subsequent calls within the
 * window return the cached series without a network round-trip.
 */
export async function getYahooHistory(
  ticker: string,
  opts: { force?: boolean } = {},
): Promise<YahooHistoryBar[] | null> {
  const dexieKey = HISTORY_DEXIE_KEY(ticker);
  const { db } = await import('../db/database');
  const cached = await db.apiCache.get(dexieKey);
  if (cached && !opts.force) {
    const age = Date.now() - new Date(cached.fetchedAt).getTime();
    if (age < HISTORY_TTL_MS) {
      try { return JSON.parse(cached.data) as YahooHistoryBar[]; } catch { /* fall through */ }
    }
  }
  const gate = shouldFetch('yahoo-history', 'yahoo', { force: opts.force, maxPerMinute: 60, subKey: ticker });
  if (!gate.allow) return cached ? safeParseHistory(cached.data) : null;
  try {
    recordCall('yahoo-history', 'yahoo', ticker);
    const data = await fetchYahoo(ticker, { range: '6mo', interval: '1d' });
    const result = data?.chart?.result?.[0];
    const timestamps = result?.timestamp;
    const quote = result?.indicators?.quote?.[0];
    const closes = quote?.close;
    const volumes = quote?.volume;
    if (!timestamps || !closes || timestamps.length !== closes.length) return null;
    const bars: YahooHistoryBar[] = [];
    for (let i = 0; i < timestamps.length; i++) {
      const c = closes[i];
      if (typeof c !== 'number') continue;
      bars.push({
        t: timestamps[i],
        close: c,
        volume: typeof volumes?.[i] === 'number' ? (volumes![i] as number) : null,
      });
    }
    if (bars.length < 15) return null;
    const now = new Date();
    await db.apiCache.put({
      cacheKey: dexieKey,
      data: JSON.stringify(bars),
      fetchedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + HISTORY_TTL_MS).toISOString(),
    });
    return bars;
  } catch (e) {
    console.warn('[yahoo history]', ticker, (e as Error).message);
    return cached ? safeParseHistory(cached.data) : null;
  }
}

function safeParseHistory(raw: string): YahooHistoryBar[] | null {
  try { return JSON.parse(raw) as YahooHistoryBar[]; } catch { return null; }
}

// Detect tickers that won't work on Finnhub's free tier (anything with a non-US suffix).
const INTL_SUFFIX_RE =
  /\.(L|HE|ST|DE|F|PA|MI|AS|BR|OL|CO|LS|MC|SW|VI|WA|PR|IC|AT|HK|T|TO|V|SA|MX|TA|JO|SI|AX)$/i;

export function isInternationalTicker(ticker: string): boolean {
  return INTL_SUFFIX_RE.test(ticker);
}
