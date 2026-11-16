// v1.21 (NCC#238) — the desktop's market-data proxy table.
//
// The finance clients pick their base URL with `Capacitor.isNativePlatform()`.
// That is false in Electron, so the desktop takes the WEB path and asks for
// same-origin proxy paths (`/yfin/...`, `/fh/...`, `/cg/...`). On the web those
// are Vercel rewrites (`vercel.json`); in dev they are Vite's proxy. On the
// desktop they reached `protocol.handle`, found no file, and were answered with
// `index.html` and a 200, so every provider got HTML where it expected JSON:
// prices, news, fundamentals, crypto and FX were all dead on the desktop.
//
// The main process has no CORS, so it can do what the rewrites do. This module
// is the table it does it from, kept pure (no Electron) so it can be tested:
//
//   - **Allow-list only.** A path that matches none of these prefixes is not a
//     proxy request, and keeps the file/SPA behaviour it always had.
//   - **The upstream host comes from this table, never from the request.** The
//     request contributes a path and a query string, and both are set on a URL
//     whose origin is already fixed, so `/yfin@evil.example/...` or an encoded
//     `..` cannot move the request to another host. No open proxy.
//   - **GET only**, enforced by the caller.
//   - **Request headers are an allow-list too**: what the clients send on
//     purpose (Accept, Accept-Language, the Finnhub key header). Nothing else
//     from the renderer is forwarded.
//
// CoinGecko goes direct from the desktop's own (residential) IP, as Android
// does, so it needs no key; the `api/v3/` restriction mirrors `api/cg.ts`.
'use strict';

/** Yahoo 401s requests without a browser-like User-Agent, and a renderer is
 *  not allowed to set one. The native path sends this same string. */
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** Yahoo's consent endpoint. Visiting it sets the cookies `getcrumb` and
 *  `quoteSummary` need (see `src/api/yahooFundamentals.ts`). */
const YAHOO_CONSENT_URL = 'https://fc.yahoo.com';

// Order matters only where one prefix starts another: `/yfin2/` is tried
// before `/yfin/`, though the trailing slash already keeps them apart.
const ROUTES = Object.freeze([
  { prefix: '/yfin2/', upstream: 'https://query2.finance.yahoo.com', yahoo: true },
  { prefix: '/yfin/', upstream: 'https://query1.finance.yahoo.com', yahoo: true },
  { prefix: '/fh/', upstream: 'https://finnhub.io' },
  { prefix: '/cg/', upstream: 'https://api.coingecko.com', pathPrefix: '/api/v3/' },
  { prefix: '/fx/', upstream: 'https://open.er-api.com' },
  { prefix: '/ecb-api/', upstream: 'https://data-api.ecb.europa.eu' },
]);

const FORWARDED_HEADERS = Object.freeze(['accept', 'accept-language', 'x-finnhub-token']);

/**
 * Map an app-origin request URL to its upstream, or null when it is not a
 * proxy request (or is one that is refused).
 *
 * @param {string} requestUrl e.g. `nexus://app/yfin/v8/finance/chart/AAPL?range=1d`
 * @param {string} [appOrigin] the app's own origin, `nexus://app`
 * @returns {{ target: string, yahoo: boolean, crumb: boolean } | null}
 */
function mapProxyRequest(requestUrl, appOrigin = 'nexus://app') {
  let url;
  let origin;
  try {
    url = new URL(requestUrl);
    origin = new URL(appOrigin);
  } catch {
    return null;
  }
  if (url.protocol !== origin.protocol || url.host !== origin.host) return null;

  const route = ROUTES.find((r) => url.pathname.startsWith(r.prefix));
  if (!route) return null;

  const rest = url.pathname.slice(route.prefix.length - 1); // keeps the leading '/'
  const target = new URL(route.upstream);
  target.pathname = rest; // normalises '.' and '..' within the fixed host
  target.search = url.search;

  // Belt and braces: whatever the path did, the origin is the table's.
  if (target.origin !== new URL(route.upstream).origin) return null;
  if (route.pathPrefix && !target.pathname.startsWith(route.pathPrefix)) return null;

  return {
    target: target.toString(),
    yahoo: !!route.yahoo,
    crumb: !!route.yahoo && target.pathname === '/v1/test/getcrumb',
  };
}

/**
 * The headers to send upstream: the allow-listed ones from the renderer, plus
 * the browser User-Agent for Yahoo.
 *
 * @param {{ get(name: string): string | null }} incoming
 * @param {boolean} yahoo
 * @returns {Record<string, string>}
 */
function upstreamHeaders(incoming, yahoo) {
  const out = {};
  for (const name of FORWARDED_HEADERS) {
    const v = incoming.get(name);
    if (v) out[name] = v;
  }
  if (yahoo) out['user-agent'] = BROWSER_UA;
  return out;
}

module.exports = { mapProxyRequest, upstreamHeaders, ROUTES, BROWSER_UA, YAHOO_CONSENT_URL };
