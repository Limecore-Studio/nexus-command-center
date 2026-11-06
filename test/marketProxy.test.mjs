import { describe, it, expect } from 'vitest';
import { mapProxyRequest, upstreamHeaders, BROWSER_UA } from '../electron/marketProxy.cjs';

// v1.21 (NCC#238). The desktop asks for the web edition's proxy paths, and the
// main process forwards an exact allow-list of them. These pin the table to
// vercel.json / vite.config.ts and pin the refusals that keep it from being an
// open proxy.

const at = (p) => `nexus://app${p}`;
const target = (p) => mapProxyRequest(at(p))?.target ?? null;

describe('mapProxyRequest: every web path maps to its upstream', () => {
  it('Yahoo chart and search go to query1', () => {
    expect(target('/yfin/v8/finance/chart/AAPL?range=1d&interval=5m'))
      .toBe('https://query1.finance.yahoo.com/v8/finance/chart/AAPL?range=1d&interval=5m');
    expect(target('/yfin/v1/finance/search?q=nokia&newsCount=5'))
      .toBe('https://query1.finance.yahoo.com/v1/finance/search?q=nokia&newsCount=5');
  });

  it('Yahoo quoteSummary and getcrumb go to query2', () => {
    expect(target('/yfin2/v10/finance/quoteSummary/NOKIA.HE?modules=assetProfile&crumb=a%2Fb'))
      .toBe('https://query2.finance.yahoo.com/v10/finance/quoteSummary/NOKIA.HE?modules=assetProfile&crumb=a%2Fb');
    const crumb = mapProxyRequest(at('/yfin2/v1/test/getcrumb'));
    expect(crumb).toEqual({ target: 'https://query2.finance.yahoo.com/v1/test/getcrumb', yahoo: true, crumb: true });
  });

  it('Finnhub, CoinGecko, FX and ECB', () => {
    expect(target('/fh/api/v1/quote?symbol=NVDA')).toBe('https://finnhub.io/api/v1/quote?symbol=NVDA');
    expect(target('/cg/api/v3/coins/markets?vs_currency=eur&ids=bitcoin'))
      .toBe('https://api.coingecko.com/api/v3/coins/markets?vs_currency=eur&ids=bitcoin');
    expect(target('/fx/v6/latest/USD')).toBe('https://open.er-api.com/v6/latest/USD');
    expect(target('/ecb-api/service/data/FM/B.U2.EUR.4F.KR.DFR.LEV?format=jsondata&lastNObservations=1'))
      .toBe('https://data-api.ecb.europa.eu/service/data/FM/B.U2.EUR.4F.KR.DFR.LEV?format=jsondata&lastNObservations=1');
  });

  it('flags Yahoo routes (they get the browser User-Agent) and nothing else', () => {
    expect(mapProxyRequest(at('/yfin/v8/finance/chart/X')).yahoo).toBe(true);
    expect(mapProxyRequest(at('/fh/api/v1/quote')).yahoo).toBe(false);
    expect(mapProxyRequest(at('/yfin2/v10/finance/quoteSummary/X')).crumb).toBe(false);
  });
});

describe('mapProxyRequest: anything else is not a proxy request', () => {
  it('app files and SPA routes are left alone', () => {
    for (const p of ['/', '/index.html', '/assets/index-abc.js', '/finance/portfolio', '/fhx/api', '/yfinance/x', '/cg']) {
      expect(mapProxyRequest(at(p)), p).toBeNull();
    }
  });

  it('another origin or scheme is refused', () => {
    expect(mapProxyRequest('nexus://other/yfin/v8/finance/chart/X')).toBeNull();
    expect(mapProxyRequest('https://app/yfin/v8/finance/chart/X')).toBeNull();
    expect(mapProxyRequest('not a url')).toBeNull();
  });

  it('a host cannot be injected through the path', () => {
    expect(mapProxyRequest(at('/yfin@evil.example/v8/finance/chart/X'))).toBeNull();
    expect(mapProxyRequest(at('/yfin/../../evil'))).toBeNull();
    for (const p of [
      '/yfin//evil.example/x',
      '/yfin/@evil.example/x',
      '/yfin/%2e%2e/%2e%2e/x',
      '/fh/..%2f..%2fx',
      '/fx/%2F%2Fevil.example/x',
      '/yfin/v8/chart?u=https://evil.example/',
    ]) {
      const m = mapProxyRequest(at(p));
      if (m) expect(new URL(m.target).host, p).toMatch(/^(query1\.finance\.yahoo\.com|finnhub\.io|open\.er-api\.com)$/);
    }
  });

  it('CoinGecko stays under api/v3, as the web function does', () => {
    expect(mapProxyRequest(at('/cg/api/v3/ping'))).not.toBeNull();
    expect(mapProxyRequest(at('/cg/api/v4/x'))).toBeNull();
    expect(mapProxyRequest(at('/cg/api/v3/../v4/x'))).toBeNull();
    expect(mapProxyRequest(at('/cg/'))).toBeNull();
  });
});

describe('upstreamHeaders', () => {
  const incoming = (h) => ({ get: (n) => h[n.toLowerCase()] ?? null });

  it('forwards only the allow-listed headers', () => {
    const h = upstreamHeaders(incoming({
      accept: 'application/json',
      'accept-language': 'fi',
      'x-finnhub-token': 'k',
      cookie: 'session=secret',
      authorization: 'Bearer t',
      origin: 'nexus://app',
    }), false);
    expect(h).toEqual({ accept: 'application/json', 'accept-language': 'fi', 'x-finnhub-token': 'k' });
  });

  it('adds the browser User-Agent for Yahoo only', () => {
    expect(upstreamHeaders(incoming({}), true)).toEqual({ 'user-agent': BROWSER_UA });
    expect(upstreamHeaders(incoming({}), false)).toEqual({});
  });
});
