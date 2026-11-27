import { loadAxios } from './http';
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { readCache, writeCache, shouldFetch, recordCall } from './cache';
import { getApiKey } from './keys';
import { getYahooQuote, isInternationalTicker, lastProviderErrors } from './yahoo';

// Native: direct. Web dev preview: through Vite proxy (Finnhub does send
// CORS headers for most endpoints but flaky in some setups — proxying is
// safer + symmetric with the other providers).
const BASE_URL = Capacitor.isNativePlatform()
  ? 'https://finnhub.io/api/v1'
  : '/fh/api/v1';

// ─── v1.2.1 — shared Finnhub fetch helper (native CapacitorHttp + web axios) ───
//
// Original symptom (BUG report 2026-06): "Network Error" on portfolio refresh
// for some holdings; on retry only NVDA + AKER BP still failed. NVDA is a
// US large-cap that Finnhub free tier fully supports — there's no business
// reason for it to fail. Diagnosis:
//
//   - On native Android, the previous code path went axios → WebView XHR →
//     CORS preflight (because `X-Finnhub-Token` is a custom header). The
//     WebView's preflight handling for parallel cross-origin requests with
//     custom headers is flaky — when Promise.all fires 5+ quotes in
//     parallel on a cold cache, several requests race the same preflight
//     and fail with the generic "Network Error" (the request never completes
//     so axios reports no status code).
//   - On retry the preflight is cached at the WebView layer, so most succeed.
//     The remaining ones (NVDA, etc.) get unlucky on the second race too.
//   - AKER BP is a separate problem — needs to be stored as `AKRBP.OL` so
//     the international-ticker check skips Finnhub entirely.
//
// Fix: mirror what Yahoo already does (yahoo.ts:fetchYahoo). On native,
// `CapacitorHttp.request()` goes through Android's native HTTP stack and
// bypasses the WebView's CORS check entirely. No preflight, no race.
// Per-request native HTTP is the same model Capacitor uses for fetch()
// when the `CapacitorHttp` plugin is enabled, and it removes the entire
// class of WebView CORS bugs from Finnhub at the cost of one helper.
//
// Used by every Finnhub endpoint in the api/ tree (quote here, plus
// stockDetail.ts metric/recommendation/news/earnings/dividend and
// companyProfile.ts profile2 and marketNews.ts general news).

export async function finnhubGet<T>(
  path: string,
  params: Record<string, string | number | undefined>,
  apiKey: string,
  opts: { timeout?: number } = {},
): Promise<T> {
  const timeout = opts.timeout ?? 8000;
  // Strip undefined params — CapacitorHttp serializes them as the literal
  // string "undefined" which confuses the upstream API.
  const cleanParams: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) {
    if (v != null) cleanParams[k] = String(v);
  }

  if (Capacitor.isNativePlatform()) {
    const url = `${BASE_URL}${path}`;
    const res = await CapacitorHttp.request({
      method: 'GET',
      url,
      params: cleanParams,
      headers: { 'X-Finnhub-Token': apiKey },
      connectTimeout: timeout,
      readTimeout: timeout,
    });
    if (res.status >= 400) {
      throw new Error(`Finnhub HTTP ${res.status}`);
    }
    const body = res.data;
    // CapacitorHttp auto-parses JSON when Content-Type indicates so; some
    // edges still hand back a string. Handle both.
    if (typeof body === 'string') {
      try {
        return JSON.parse(body) as T;
      } catch {
        throw new Error('Finnhub returned non-JSON body');
      }
    }
    return body as T;
  }

  // Web dev preview: through Vite's /fh proxy so CORS is handled at the
  // dev-server layer and the browser sees a same-origin request.
  const axios = await loadAxios();
  const { data } = await axios.get<T>(`${BASE_URL}${path}`, {
    params: cleanParams,
    headers: { 'X-Finnhub-Token': apiKey },
    timeout,
  });
  return data;
}

export interface FinnhubQuote {
  c: number;  // current price
  d: number;  // change
  dp: number; // change percent
  h: number;  // high
  l: number;  // low
  o: number;  // open
  pc: number; // previous close
  /** Unix seconds of the last trade (Finnhub sends it; v1.22 keeps it so a
   *  pre-open quote is not read as today's move). */
  t?: number;
}

export interface QuoteResult {
  ticker: string;
  quote: FinnhubQuote;
  currency: string;
  ageMinutes: number;
  cached: boolean;
  stale: boolean;
  source: 'finnhub' | 'yahoo';
}

async function finnhubFetch(
  ticker: string,
  opts: { force?: boolean } = {},
): Promise<QuoteResult | null> {
  const key = `finnhub_${ticker.toUpperCase()}`;
  const cached = await readCache<FinnhubQuote>(key);

  if (cached?.fresh && !opts.force) {
    return { ticker, quote: cached.data, ageMinutes: cached.ageMinutes, currency: 'USD', cached: true, stale: false, source: 'finnhub' };
  }

  const apiKey = await getApiKey('finnhub');
  if (!apiKey) {
    // "No key" isn't an error — it's the expected fallback flow (caller
    // will try Yahoo next). Pushing this to lastProviderErrors floods the
    // UI's error panel with N-tickers × 2-paths worth of meaningless rows
    // when the user simply hasn't entered a key. Just return null silently.
    if (cached) return { ticker, quote: cached.data, ageMinutes: cached.ageMinutes, currency: 'USD', cached: true, stale: true, source: 'finnhub' };
    return null;
  }

  // Quotes honor `force` from the user's ↻ tap (soft interval is short — 60s —
  // so back-to-back taps still gate, but a deliberate refresh after 1 minute
  // goes through). Daily budget + per-minute caps still apply as hard limits.
  const gate = shouldFetch('finnhub', 'finnhub', { force: opts.force, maxPerMinute: 60, subKey: ticker });
  if (!gate.allow) {
    lastProviderErrors.push({ provider: 'finnhub', ticker, message: gate.reason ?? 'rate-limited' });
    if (cached) return { ticker, quote: cached.data, ageMinutes: cached.ageMinutes, currency: 'USD', cached: true, stale: true, source: 'finnhub' };
    return null;
  }

  try {
    recordCall('finnhub', 'finnhub', ticker);
    // v1.2.1 — routed through finnhubGet so native uses CapacitorHttp and
    // bypasses the WebView CORS preflight. The `X-Finnhub-Token` header is
    // sent natively which avoids the preflight entirely on native and stays
    // proxy-friendly on web. Auth via header (vs legacy `?token=`) keeps the
    // secret out of access logs / browser history / TLS-MITM-cert paths.
    const data = await finnhubGet<FinnhubQuote>(
      '/quote',
      { symbol: ticker.toUpperCase() },
      apiKey,
      { timeout: 8000 },
    );
    // Finnhub free tier returns c=0 for unsupported exchanges. Bail so the caller
    // can fall through to Yahoo.
    if (!data || typeof data.c !== 'number' || data.c === 0) {
      lastProviderErrors.push({ provider: 'finnhub', ticker, message: 'unsupported symbol (c=0)' });
      return null;
    }
    await writeCache(key, data);
    return { ticker, quote: data, currency: 'USD', ageMinutes: 0, cached: false, stale: false, source: 'finnhub' };
  } catch (e) {
    const msg = (e as Error).message || String(e);
    lastProviderErrors.push({ provider: 'finnhub', ticker, message: msg });
    console.warn('[finnhub]', ticker, msg);
    if (cached) {
      return { ticker, quote: cached.data, ageMinutes: cached.ageMinutes, currency: 'USD', cached: true, stale: true, source: 'finnhub' };
    }
    return null;
  }
}

async function yahooFetch(
  ticker: string,
  opts: { force?: boolean } = {},
): Promise<QuoteResult | null> {
  const result = await getYahooQuote(ticker, opts);
  if (!result) return null;
  return {
    ticker,
    quote: result.quote,
    currency: result.currency,
    ageMinutes: result.ageMinutes,
    cached: result.cached,
    stale: result.stale,
    source: 'yahoo',
  };
}

async function getQuote(
  ticker: string,
  opts: { force?: boolean } = {},
): Promise<QuoteResult | null> {
  // Route international tickers straight to Yahoo (Finnhub free tier is US-only).
  if (isInternationalTicker(ticker)) {
    return yahooFetch(ticker, opts);
  }
  // US tickers: try Finnhub first. A stale Finnhub result must NOT short-circuit
  // the Yahoo fallback (that was the cache prison). Use Finnhub only if fresh;
  // otherwise let Yahoo try for fresh; fall back to whichever stale we have if
  // both fail.
  const fh = await finnhubFetch(ticker, opts);
  if (fh && !fh.stale) return fh;

  const yh = await yahooFetch(ticker, opts);
  if (yh && !yh.stale) return yh;

  if (fh && yh) return yh.ageMinutes < fh.ageMinutes ? yh : fh;
  return yh ?? fh ?? null;
}

export async function getQuotes(
  tickers: string[],
  opts: { force?: boolean } = {},
): Promise<QuoteResult[]> {
  const results = await Promise.all(tickers.map((t) => getQuote(t, opts)));
  return results.filter((r): r is QuoteResult => r !== null);
}
