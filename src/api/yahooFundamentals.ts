// Yahoo's unofficial `quoteSummary` endpoint covers the same data shape we
// pull from Finnhub for US tickers, but for global exchanges (LSE, Helsinki,
// Frankfurt, Tokyo, etc.). Used as a fallback when:
//   - Finnhub returns null (free tier limits)
//   - Ticker is international (we don't even try Finnhub for those)
//   - User hasn't entered a Finnhub key
//
// **Crumb authentication.** ~2 years ago Yahoo locked quoteSummary (and a few
// other endpoints) behind a "crumb" handshake — every request needs a
// `crumb=...` query parameter, AND the user must have consent cookies set.
// Procedure:
//   1. GET https://fc.yahoo.com to set the EU-consent + B-cookies. CapacitorHttp
//      auto-persists these via the platform CookieManager.
//   2. GET https://query2.finance.yahoo.com/v1/test/getcrumb — returns the
//      crumb as plain text body (not JSON). Cookie from step 1 must be sent.
//   3. Include &crumb=XXX on subsequent quoteSummary calls.
// Crumbs last for ~1 hour in practice; we re-fetch on 401 or after our cache
// expires. The /chart and /search endpoints (used elsewhere in the app) don't
// require this, only quoteSummary.
//
// On Android we use CapacitorHttp to bypass CORS (same pattern as quotes).

import { loadAxios } from './http';
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { db } from '../db/database';
import { shouldFetch, recordCall } from './cache';
import { lastProviderErrors, readChartMeta } from './yahoo';
import { buildRelevanceCheck, isNewsRelevant } from '../lib/newsRelevance';
import type { StockMetric, EarningsEvent, DividendEvent, NewsItem, Recommendation } from './stockDetail';
import { IS_DESKTOP } from '../lib/isDesktop';

// Native: direct (CapacitorHttp bypasses CORS). Web dev preview: proxied
// through Vite. quoteSummary + crumb live on query2; search lives on query1.
// The consent endpoint isn't proxied — it's a redirect target only hit on
// the cookie-consent path, which is broken on web anyway (cookies don't
// survive the proxy boundary). Tier-2 fundamentals fall through cleanly
// when this returns null.
const _NATIVE = Capacitor.isNativePlatform();
const SUMMARY_URL = _NATIVE
  ? 'https://query2.finance.yahoo.com/v10/finance/quoteSummary'
  : '/yfin2/v10/finance/quoteSummary';
const SEARCH_URL = _NATIVE
  ? 'https://query1.finance.yahoo.com/v1/finance/search'
  : '/yfin/v1/finance/search';
const CONSENT_URL = 'https://fc.yahoo.com';
const CRUMB_URL = _NATIVE
  ? 'https://query2.finance.yahoo.com/v1/test/getcrumb'
  : '/yfin2/v1/test/getcrumb';
const TTL_MS = 24 * 60 * 60 * 1000; // 24h
const NEWS_TTL_MS = 6 * 60 * 60 * 1000;
const CRUMB_TTL_MS = 55 * 60 * 1000; // Yahoo's crumb lives ~1h; refresh 5min early

const BROWSER_HEADERS: Record<string, string> = {
  Accept: 'application/json, text/javascript, */*; q=0.01',
  'Accept-Language': 'en-US,en;q=0.9',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
};

// Same headers minus User-Agent — browsers refuse to set that header on XHR
// and emit "Refused to set unsafe header" warnings on every call. The UA is
// only needed on the native CapacitorHttp path; in the web fallback the
// browser supplies its own anyway.
const WEB_HEADERS: Record<string, string> = Object.fromEntries(
  Object.entries(BROWSER_HEADERS).filter(([k]) => k.toLowerCase() !== 'user-agent'),
);

// In-memory crumb cache. Module-scoped so multiple parallel fetches share
// one consent handshake rather than each kicking off their own.
let cachedCrumb: string | null = null;
let crumbExpiresAt = 0;
let pendingCrumbFetch: Promise<string | null> | null = null;

async function fetchCrumb(): Promise<string | null> {
  // Web (dev preview) — CORS blocks both consent + crumb, so we can't even
  // try. Quote/search endpoints work in dev because they have permissive
  // CORS, but quoteSummary doesn't. Just return null and let callers route
  // around (chart-meta fallback covers most fields on web too).
  if (!Capacitor.isNativePlatform()) {
    if (IS_DESKTOP) return fetchCrumbDesktop();
    return null;
  }
  try {
    // Step 1: visit consent endpoint to set cookies. Don't care about the
    // body; success or any 3xx redirect both set the cookies.
    await CapacitorHttp.request({
      method: 'GET',
      url: CONSENT_URL,
      headers: BROWSER_HEADERS,
      connectTimeout: 6000,
      readTimeout: 6000,
    });
    // Step 2: ask for the crumb. Response body is the crumb string itself.
    const res = await CapacitorHttp.request({
      method: 'GET',
      url: CRUMB_URL,
      headers: BROWSER_HEADERS,
      connectTimeout: 6000,
      readTimeout: 6000,
    });
    if (res.status !== 200) {
      lastProviderErrors.push({ provider: 'yahoo', message: `crumb HTTP ${res.status}` });
      return null;
    }
    const body = typeof res.data === 'string' ? res.data : String(res.data ?? '');
    const trimmed = body.trim();
    // Sanity: Yahoo crumbs are short alphanumeric+punctuation strings, NEVER
    // multi-line or wrapped in JSON. Anything else is a consent page redirect.
    if (!trimmed || trimmed.length > 80 || /[<>{\n]/.test(trimmed)) {
      lastProviderErrors.push({ provider: 'yahoo', message: `crumb shape unexpected (${trimmed.slice(0, 30)}…)` });
      return null;
    }
    return trimmed;
  } catch (e) {
    lastProviderErrors.push({ provider: 'yahoo', message: `crumb: ${(e as Error).message}` });
    return null;
  }
}

// v1.21 (NCC#238) — the desktop gets its crumb through the main process's
// proxy (electron/marketProxy.cjs), which runs the consent step itself and
// keeps Yahoo's cookies in the app session, so the quoteSummary calls that
// follow carry them. Same shape check as the native path.
async function fetchCrumbDesktop(): Promise<string | null> {
  try {
    const axios = await loadAxios();
    const { data, status } = await axios.get(CRUMB_URL, {
      headers: WEB_HEADERS,
      responseType: 'text',
      transformResponse: (d: unknown) => d,
      timeout: 10_000,
      validateStatus: () => true,
    });
    if (status !== 200) {
      lastProviderErrors.push({ provider: 'yahoo', message: `crumb HTTP ${status}` });
      return null;
    }
    return checkCrumbShape(typeof data === 'string' ? data : String(data ?? ''));
  } catch (e) {
    lastProviderErrors.push({ provider: 'yahoo', message: `crumb: ${(e as Error).message}` });
    return null;
  }
}

function checkCrumbShape(body: string): string | null {
  const trimmed = body.trim();
  if (!trimmed || trimmed.length > 80 || /[<>{\n]/.test(trimmed)) {
    lastProviderErrors.push({ provider: 'yahoo', message: `crumb shape unexpected (${trimmed.slice(0, 30)}…)` });
    return null;
  }
  return trimmed;
}

async function getCrumb(force = false): Promise<string | null> {
  if (!force && cachedCrumb && Date.now() < crumbExpiresAt) return cachedCrumb;
  // Coalesce concurrent fetches — first caller starts the handshake, rest
  // await the same promise. Reset on resolve so retries can re-trigger.
  if (pendingCrumbFetch) return pendingCrumbFetch;
  pendingCrumbFetch = (async () => {
    const c = await fetchCrumb();
    if (c) {
      cachedCrumb = c;
      crumbExpiresAt = Date.now() + CRUMB_TTL_MS;
    }
    return c;
  })();
  try {
    return await pendingCrumbFetch;
  } finally {
    pendingCrumbFetch = null;
  }
}

// ── Cache helpers (parallel to stockDetail.ts) ────────────────────────────

async function readCacheTTL<T>(key: string, ttl: number): Promise<T | null> {
  const entry = await db.apiCache.get(key);
  if (!entry) return null;
  if (Date.now() - new Date(entry.fetchedAt).getTime() > ttl) return null;
  try {
    return JSON.parse(entry.data) as T;
  } catch {
    return null;
  }
}

async function writeCacheTTL(key: string, data: unknown, ttl: number): Promise<void> {
  const now = new Date();
  await db.apiCache.put({
    cacheKey: key,
    data: JSON.stringify(data),
    fetchedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttl).toISOString(),
  });
}

// ── Raw transport ─────────────────────────────────────────────────────────

interface FetchOpts {
  // Append `crumb=XXX` to the query when true. Triggers consent + crumb
  // fetch on miss. Retries once with a fresh crumb on 401.
  withCrumb?: boolean;
}

async function fetchJson(
  url: string,
  params: Record<string, string>,
  opts: FetchOpts = {},
): Promise<unknown> {
  const buildUrl = (crumb: string | null): string => {
    const merged = { ...params };
    if (crumb) merged.crumb = crumb;
    const qs = '?' + Object.entries(merged).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    return url + qs;
  };

  const doFetch = async (crumb: string | null): Promise<{ status: number; body: unknown }> => {
    if (Capacitor.isNativePlatform()) {
      const res = await CapacitorHttp.request({
        method: 'GET',
        url: buildUrl(crumb),
        headers: BROWSER_HEADERS,
        connectTimeout: 10_000,
        readTimeout: 10_000,
      });
      let body: unknown = res.data;
      if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch { /* leave as string; caller handles */ }
      }
      return { status: res.status, body };
    }
    // Web — no cookies + CORS make crumb auth impossible. The chart-meta
    // path is the right fallback in dev.
    const axios = await loadAxios();
    const { data, status } = await axios.get(buildUrl(crumb), {
      headers: WEB_HEADERS,
      timeout: 10_000,
      validateStatus: () => true, // never throw — we want to inspect 401 ourselves
    });
    return { status, body: data };
  };

  let crumb: string | null = null;
  if (opts.withCrumb) crumb = await getCrumb();
  let { status, body } = await doFetch(crumb);

  // 401 with crumb: cached crumb might be expired. Force-refresh once and retry.
  if (opts.withCrumb && status === 401) {
    const fresh = await getCrumb(true);
    if (fresh && fresh !== crumb) {
      const retry = await doFetch(fresh);
      status = retry.status;
      body = retry.body;
    }
  }

  if (status >= 400) {
    throw new Error(`Yahoo HTTP ${status}${opts.withCrumb && !crumb ? ' (no crumb)' : ''}`);
  }
  if (typeof body === 'string') {
    throw new Error('Yahoo: non-JSON body');
  }
  return body;
}

// ── quoteSummary → StockMetric ────────────────────────────────────────────

interface QuoteSummaryRaw {
  quoteSummary?: {
    result?: Array<{
      assetProfile?: { sector?: string; industry?: string; country?: string };
      summaryDetail?: {
        trailingPE?: { raw?: number };
        forwardPE?: { raw?: number };
        priceToSalesTrailing12Months?: { raw?: number };
        dividendYield?: { raw?: number };          // fractional, e.g. 0.0235 = 2.35%
        marketCap?: { raw?: number };              // raw value in USD
        fiftyTwoWeekHigh?: { raw?: number };
        fiftyTwoWeekLow?: { raw?: number };
        beta?: { raw?: number };
      };
      defaultKeyStatistics?: {
        priceToBook?: { raw?: number };
        forwardEps?: { raw?: number };
        trailingEps?: { raw?: number };
        // v1.2 follow-up — BUG-8. Yahoo publishes pegRatio as a free field
        // on defaultKeyStatistics. Maps to Finnhub `pegRatioBasicExclExtraTTM`.
        pegRatio?: { raw?: number };
      };
      financialData?: {
        returnOnEquity?: { raw?: number };
        // v1.2 follow-up — BUG-8. Yahoo's debtToEquity field is the actual
        // ratio (e.g. 1.24 = 124% leverage), matching Finnhub's
        // `totalDebt/totalEquityAnnual` shape. NOT a fraction — no ×100
        // needed. Some symbols return values like 124 (already percent);
        // we normalize: anything > 10 is treated as percent and /100'd.
        debtToEquity?: { raw?: number };
        // YoY revenue growth, fractional (0.12 = 12%). Finnhub publishes the
        // same as percent on `revenueGrowthTTMYoy`. We multiply ×100 to
        // normalize.
        revenueGrowth?: { raw?: number };
      };
      // v1.2 follow-up — BUG-8. Analyst recommendation trend for non-US.
      // Yahoo's `recommendationTrend.trend` is monthly: '0m' = current month,
      // '-1m', '-2m', '-3m' = trailing. We synthesize a YYYY-MM-DD period for
      // each by walking backwards from today so the shape matches Finnhub's
      // /stock/recommendation.
      recommendationTrend?: {
        trend?: Array<{
          period: string; // '0m' | '-1m' | '-2m' | '-3m'
          strongBuy: number;
          buy: number;
          hold: number;
          sell: number;
          strongSell: number;
        }>;
      };
      // v1.2 follow-up — BUG-8. Historical earnings actuals + estimates for
      // the surprise signal. Yahoo's `earningsHistory.history` carries up to
      // 4 quarters with `epsActual` / `epsEstimate` / `period` (e.g. '-1q')
      // / `quarter.fmt` (YYYY-MM-DD quarter-end).
      earningsHistory?: {
        history?: Array<{
          epsActual?: { raw?: number };
          epsEstimate?: { raw?: number };
          period?: string;        // '-1q', '-2q', etc.
          quarter?: { fmt?: string; raw?: number };
        }>;
      };
      calendarEvents?: {
        earnings?: {
          earningsDate?: { fmt?: string; raw?: number }[];
          earningsAverage?: { raw?: number };
          earningsLow?: { raw?: number };
          earningsHigh?: { raw?: number };
        };
        exDividendDate?: { fmt?: string; raw?: number };
        dividendDate?: { fmt?: string; raw?: number };
      };
      price?: { currency?: string; regularMarketPrice?: { raw?: number } };
    }>;
  };
}

// Synthesize a thin StockMetric from the chart-meta cache (already populated
// by every successful getYahooQuote call). Used when quoteSummary is
// unreachable — gives us 52w high/low and a longName at minimum.
async function metricFromChartMeta(ticker: string): Promise<StockMetric | null> {
  const meta = await readChartMeta(ticker);
  if (!meta) return null;
  if (meta.high52w == null && meta.low52w == null) return null;
  return {
    ticker: ticker.toUpperCase(),
    high52w: meta.high52w,
    low52w: meta.low52w,
  };
}

export async function getYahooMetric(ticker: string): Promise<StockMetric | null> {
  const cacheKey = `yh_metric_${ticker.toUpperCase()}`;
  const cached = await readCacheTTL<StockMetric>(cacheKey, TTL_MS);
  if (cached) return cached;
  const gate = shouldFetch('yahoo-summary', 'yahoo', { force: false, maxPerMinute: 30, subKey: ticker });
  if (!gate.allow) return metricFromChartMeta(ticker);
  try {
    recordCall('yahoo-summary', 'yahoo', ticker);
    const data = (await fetchJson(
      `${SUMMARY_URL}/${encodeURIComponent(ticker)}`,
      { modules: 'assetProfile,summaryDetail,defaultKeyStatistics,financialData' },
      { withCrumb: true },
    )) as QuoteSummaryRaw;
    const r = data?.quoteSummary?.result?.[0];
    if (!r) return metricFromChartMeta(ticker);
    const sd = r.summaryDetail ?? {};
    const ks = r.defaultKeyStatistics ?? {};
    const fd = r.financialData ?? {};
    // Market cap from Yahoo is raw USD (or local currency for some tickers).
    // Finnhub's marketCapitalization is in millions of USD. Normalize to
    // millions so the renderer doesn't need to special-case the source.
    const mcMillions = sd.marketCap?.raw != null ? sd.marketCap.raw / 1_000_000 : undefined;
    // v1.2 follow-up — BUG-8. Yahoo publishes debtToEquity in two different
    // shapes depending on ticker: usually as the actual ratio (1.24 = 124%
    // leverage, matches Finnhub's `totalDebt/totalEquityAnnual`), but some
    // international symbols return values already in percent (124 instead of
    // 1.24). Heuristic: anything > 10 is unrealistic as a true ratio for a
    // public equity (>1000% leverage), so treat it as percent and /100.
    const rawDe = fd.debtToEquity?.raw;
    const debtToEquity = rawDe == null ? undefined : (rawDe > 10 ? rawDe / 100 : rawDe);
    const result: StockMetric = {
      ticker: ticker.toUpperCase(),
      peNormalized: sd.trailingPE?.raw,
      pbRatio: ks.priceToBook?.raw,
      beta: sd.beta?.raw,
      high52w: sd.fiftyTwoWeekHigh?.raw,
      low52w: sd.fiftyTwoWeekLow?.raw,
      marketCap: mcMillions,
      // Yahoo's dividendYield is a fraction (0.0235). Finnhub returns
      // percent (2.35). Multiply ×100 so downstream code can render uniformly.
      dividendYield: sd.dividendYield?.raw != null ? sd.dividendYield.raw * 100 : undefined,
      epsAnnual: ks.trailingEps?.raw,
      roe: fd.returnOnEquity?.raw != null ? fd.returnOnEquity.raw * 100 : undefined,
      // v1.2 follow-up — BUG-8. Four signal inputs needed by the Fundamental
      // engine that the v1.2 implementation didn't populate. With these
      // wired up, non-US tickers gain P/S vs sector, PEG, D/E vs sector,
      // and revenue-growth signals — going from 2 of 8 available signals
      // up to 6 of 8 (recs + earnings still need separate Yahoo calls).
      psRatio: sd.priceToSalesTrailing12Months?.raw,
      pegRatio: ks.pegRatio?.raw,
      debtToEquity,
      // revenueGrowth fractional → percent (×100) to match Finnhub shape.
      revenueGrowthYoy: fd.revenueGrowth?.raw != null ? fd.revenueGrowth.raw * 100 : undefined,
    };
    await writeCacheTTL(cacheKey, result, TTL_MS);
    return result;
  } catch (e) {
    lastProviderErrors.push({ provider: 'yahoo', ticker, message: `summary: ${(e as Error).message}` });
    console.warn('[yahoo summary]', ticker, (e as Error).message);
    // Even if quoteSummary failed (no crumb, blocked, etc.), the chart-meta
    // cache populated by getYahooQuote usually has at least 52w range — give
    // the user *something* instead of an empty "unavailable" panel.
    return metricFromChartMeta(ticker);
  }
}

// ── Analyst recommendations (recommendationTrend) ───────────────────────
//
// v1.2 follow-up — BUG-8. Finnhub's /stock/recommendation is US-only on the
// free tier; international tickers got an empty array which made the
// analystConsensus signal (top-weight 20% in the composite) permanently
// unavailable. Yahoo's `recommendationTrend.trend` covers global tickers
// when analysts are following the name.
//
// Shape conversion: Yahoo returns 4 rows keyed by relative period
// ('0m','-1m','-2m','-3m'). The signal engine only cares about the most
// recent 3 months and counts the buy/hold/sell mix — period dates are
// purely for sort stability. We synthesize YYYY-MM-DD dates by walking
// backwards from today (first of month) so newest-first sort still works.

// Mirror of the weekly Fundamental cache tier used by stockDetail.ts.
const REC_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export async function getYahooRecommendations(ticker: string): Promise<Recommendation[]> {
  const cacheKey = `yh_rec_${ticker.toUpperCase()}`;
  const cached = await readCacheTTL<Recommendation[]>(cacheKey, REC_TTL_MS);
  if (cached) return cached;
  const gate = shouldFetch('yahoo-summary', 'yahoo', { force: false, maxPerMinute: 30, subKey: ticker });
  if (!gate.allow) return [];
  try {
    recordCall('yahoo-summary', 'yahoo', ticker);
    const data = (await fetchJson(
      `${SUMMARY_URL}/${encodeURIComponent(ticker)}`,
      { modules: 'recommendationTrend' },
      { withCrumb: true },
    )) as QuoteSummaryRaw;
    const trend = data?.quoteSummary?.result?.[0]?.recommendationTrend?.trend ?? [];
    if (trend.length === 0) {
      await writeCacheTTL(cacheKey, [], REC_TTL_MS);
      return [];
    }
    // Synthesize ISO dates by walking back from the first of this month.
    // '0m' → first of current month; '-1m' → first of previous month; etc.
    const now = new Date();
    const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const recommendations: Recommendation[] = trend
      .filter((t) => t.period && /^-?\d+m$/.test(t.period))
      .map((t) => {
        const monthsBack = parseInt(t.period.replace(/[^\d-]/g, ''), 10) || 0; // '0m'→0, '-1m'→-1
        const period = new Date(firstOfMonth);
        period.setMonth(period.getMonth() + monthsBack); // monthsBack is ≤0
        return {
          period: period.toISOString().slice(0, 10),
          strongBuy: t.strongBuy || 0,
          buy: t.buy || 0,
          hold: t.hold || 0,
          sell: t.sell || 0,
          strongSell: t.strongSell || 0,
        };
      })
      // Filter empty rows (some Yahoo responses have zero counts across the
      // board for symbols with no analyst coverage — would emit a misleading
      // "0 buy / 0 sell" signal).
      .filter((r) => r.strongBuy + r.buy + r.hold + r.sell + r.strongSell > 0)
      .sort((a, b) => b.period.localeCompare(a.period));
    await writeCacheTTL(cacheKey, recommendations, REC_TTL_MS);
    return recommendations;
  } catch (e) {
    lastProviderErrors.push({ provider: 'yahoo', ticker, message: `rec: ${(e as Error).message}` });
    console.warn('[yahoo rec]', ticker, (e as Error).message);
    return [];
  }
}

// ── Earnings history (earningsHistory module) ────────────────────────────
//
// v1.2 follow-up — BUG-8. Finnhub's /stock/earnings (the historical actuals
// + estimates feed that powers the earnings-surprise signal) is US-only on
// free tier. Yahoo's earningsHistory covers ~4 trailing quarters globally.
// 2 quarters is the signal-engine minimum; 4 is comfortable.

const EARN_HIST_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export async function getYahooEarningsHistory(ticker: string): Promise<EarningsEvent[]> {
  const cacheKey = `yh_earn_hist_${ticker.toUpperCase()}`;
  const cached = await readCacheTTL<EarningsEvent[]>(cacheKey, EARN_HIST_TTL_MS);
  if (cached) return cached;
  const gate = shouldFetch('yahoo-summary', 'yahoo', { force: false, maxPerMinute: 30, subKey: ticker });
  if (!gate.allow) return [];
  try {
    recordCall('yahoo-summary', 'yahoo', ticker);
    const data = (await fetchJson(
      `${SUMMARY_URL}/${encodeURIComponent(ticker)}`,
      { modules: 'earningsHistory' },
      { withCrumb: true },
    )) as QuoteSummaryRaw;
    const history = data?.quoteSummary?.result?.[0]?.earningsHistory?.history ?? [];
    if (history.length === 0) {
      await writeCacheTTL(cacheKey, [], EARN_HIST_TTL_MS);
      return [];
    }
    const events: EarningsEvent[] = history
      .filter((h) => h.epsActual?.raw != null || h.epsEstimate?.raw != null)
      .map((h) => ({
        symbol: ticker.toUpperCase(),
        // Prefer the explicit quarter-end fmt date; fall back to synthesizing
        // from the unix `raw` if Yahoo only gave us the seconds timestamp.
        date: h.quarter?.fmt
          ?? (h.quarter?.raw ? new Date(h.quarter.raw * 1000).toISOString().slice(0, 10) : ''),
        epsActual: h.epsActual?.raw,
        epsEstimate: h.epsEstimate?.raw,
      }))
      .filter((e) => e.date)
      // Newest first to match Finnhub's getEarningsHistory ordering.
      .sort((a, b) => b.date.localeCompare(a.date));
    await writeCacheTTL(cacheKey, events, EARN_HIST_TTL_MS);
    return events;
  } catch (e) {
    lastProviderErrors.push({ provider: 'yahoo', ticker, message: `earn hist: ${(e as Error).message}` });
    console.warn('[yahoo earn hist]', ticker, (e as Error).message);
    return [];
  }
}

// ── Earnings calendar (from quoteSummary.calendarEvents) ────────────────

export async function getYahooEarnings(ticker: string): Promise<EarningsEvent[]> {
  const cacheKey = `yh_earn_${ticker.toUpperCase()}`;
  const cached = await readCacheTTL<EarningsEvent[]>(cacheKey, TTL_MS);
  if (cached) return cached;
  const gate = shouldFetch('yahoo-summary', 'yahoo', { force: false, maxPerMinute: 30, subKey: ticker });
  if (!gate.allow) return [];
  try {
    recordCall('yahoo-summary', 'yahoo', ticker);
    const data = (await fetchJson(
      `${SUMMARY_URL}/${encodeURIComponent(ticker)}`,
      { modules: 'calendarEvents' },
      { withCrumb: true },
    )) as QuoteSummaryRaw;
    const earnings = data?.quoteSummary?.result?.[0]?.calendarEvents?.earnings;
    if (!earnings?.earningsDate?.length) return [];
    const events: EarningsEvent[] = earnings.earningsDate
      .filter((d) => d.fmt)
      .map((d) => ({
        symbol: ticker.toUpperCase(),
        date: d.fmt!,
        epsEstimate: earnings.earningsAverage?.raw,
      }));
    await writeCacheTTL(cacheKey, events, TTL_MS);
    return events;
  } catch (e) {
    lastProviderErrors.push({ provider: 'yahoo', ticker, message: `earnings: ${(e as Error).message}` });
    console.warn('[yahoo earnings]', ticker, (e as Error).message);
    return [];
  }
}

// ── Dividends (synthesized from yield + trailing if available) ───────────
// Yahoo doesn't expose an event-by-event dividend history via quoteSummary's
// free-tier modules. We approximate from `summaryDetail.dividendYield` +
// current price + `calendarEvents.exDividendDate`. Single synthetic event
// representing "trailing annual" — DividendTracker treats it as such because
// it just sums amounts in the window.

interface DividendApproxArgs {
  ticker: string;
  currentPrice?: number;
  currency?: string;
}

export async function getYahooDividendApproximation(args: DividendApproxArgs): Promise<DividendEvent[]> {
  const cacheKey = `yh_div_${args.ticker.toUpperCase()}`;
  const cached = await readCacheTTL<DividendEvent[]>(cacheKey, TTL_MS);
  if (cached) return cached;
  const gate = shouldFetch('yahoo-summary', 'yahoo', { force: false, maxPerMinute: 30, subKey: args.ticker });
  if (!gate.allow) return [];
  try {
    recordCall('yahoo-summary', 'yahoo', args.ticker);
    const data = (await fetchJson(
      `${SUMMARY_URL}/${encodeURIComponent(args.ticker)}`,
      { modules: 'summaryDetail,calendarEvents,price' },
      { withCrumb: true },
    )) as QuoteSummaryRaw;
    const r = data?.quoteSummary?.result?.[0];
    const yield_ = r?.summaryDetail?.dividendYield?.raw;
    // Caller can pass a current price (from existing stockQuotes state to
    // save a fetch); otherwise we read it from the price module we just
    // requested. Either way, we need a price to translate yield → per-share.
    const price = args.currentPrice ?? r?.price?.regularMarketPrice?.raw;
    const currency = args.currency ?? r?.price?.currency ?? 'USD';
    if (!yield_ || !price) {
      await writeCacheTTL(cacheKey, [], TTL_MS);
      return [];
    }
    // Approximate trailing annual dividend per share.
    const annualPerShare = yield_ * price;
    const today = new Date();
    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
    const events: DividendEvent[] = [
      {
        symbol: args.ticker.toUpperCase(),
        date: oneYearAgo.toISOString().slice(0, 10),
        amount: annualPerShare,
        currency,
      },
    ];
    // If there's a known upcoming ex-div date, also surface that — gives
    // DividendTracker something for the "Next ex-div" hint.
    const nextEx = r?.calendarEvents?.exDividendDate?.fmt;
    if (nextEx && nextEx > today.toISOString().slice(0, 10)) {
      events.push({
        symbol: args.ticker.toUpperCase(),
        date: nextEx,
        amount: 0, // we don't know the next event's payment; this is a marker
        currency,
      });
    }
    await writeCacheTTL(cacheKey, events, TTL_MS);
    return events;
  } catch (e) {
    lastProviderErrors.push({ provider: 'yahoo', ticker: args.ticker, message: `div approx: ${(e as Error).message}` });
    console.warn('[yahoo div]', args.ticker, (e as Error).message);
    return [];
  }
}

// ── News (Yahoo search endpoint) ─────────────────────────────────────────

interface YahooSearchRaw {
  news?: Array<{
    uuid: string;
    title: string;
    publisher?: string;
    link: string;
    providerPublishTime?: number; // unix seconds
    thumbnail?: { resolutions?: { url?: string }[] };
  }>;
}

export async function getYahooNews(ticker: string): Promise<NewsItem[]> {
  const cacheKey = `yh_news_${ticker.toUpperCase()}`;
  const cached = await readCacheTTL<NewsItem[]>(cacheKey, NEWS_TTL_MS);
  if (cached) return cached;
  const gate = shouldFetch('yahoo-summary', 'yahoo', { force: false, maxPerMinute: 30, subKey: ticker });
  if (!gate.allow) return [];
  // BUG-3 fix: build a relevance check up-front. Yahoo's /v1/finance/search
  // endpoint is keyword-driven; for low-coverage / international tickers it
  // degrades to fuzzy keyword search and returns stories that have nothing
  // to do with the company. We filter those out client-side. companyName
  // comes from the Yahoo chart-meta cache (populated opportunistically by
  // every quote refresh — see yahoo.ts#writeChartMeta). If absent (fresh
  // install, no quote fetched yet), we still match on ticker base.
  const meta = await readChartMeta(ticker);
  const check = buildRelevanceCheck(ticker, meta?.longName);
  try {
    recordCall('yahoo-summary', 'yahoo', ticker);
    const data = (await fetchJson(SEARCH_URL, {
      q: ticker.toUpperCase(),
      newsCount: '10',
      quotesCount: '0',
    })) as YahooSearchRaw;
    const raw = data?.news ?? [];
    const rejectedCount = { n: 0 };
    const news: NewsItem[] = raw
      .filter((n) => n.title && n.link && n.providerPublishTime)
      .map((n, i) => ({
        id: parseInt(n.uuid?.replace(/\D/g, '').slice(0, 9) || `${i}`, 10) || i,
        ticker: ticker.toUpperCase(),
        datetime: n.providerPublishTime!,
        headline: n.title,
        source: n.publisher ?? 'Yahoo',
        url: n.link,
        image: n.thumbnail?.resolutions?.[0]?.url,
      }))
      // BUG-3: strict relevance filter — drop anything not actually about
      // this company. Better to show an empty per-holding section than to
      // misattribute (e.g. Trump/sanctuary-city story tagged as Nordea).
      .filter((item) => {
        const ok = isNewsRelevant(item, check);
        if (!ok) rejectedCount.n += 1;
        return ok;
      })
      .sort((a, b) => b.datetime - a.datetime)
      .slice(0, 10);
    if (rejectedCount.n > 0) {
      console.debug(
        `[yahoo news] ${ticker}: filtered ${rejectedCount.n} off-topic ` +
          `story/stories (check: base=${check.tickerBase} key=${check.companyKey ?? '?'})`,
      );
    }
    await writeCacheTTL(cacheKey, news, NEWS_TTL_MS);
    return news;
  } catch (e) {
    lastProviderErrors.push({ provider: 'yahoo', ticker, message: `news: ${(e as Error).message}` });
    console.warn('[yahoo news]', ticker, (e as Error).message);
    return [];
  }
}
