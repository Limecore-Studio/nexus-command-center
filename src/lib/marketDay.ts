// v1.22 (NCC#263) — which US trading day a quote belongs to.
//
// Before the open, a quote still holds the previous session: `c` is that
// day's close and `pc` the day before's. Read as "today", it reported
// yesterday's move (a European user opening the app at 08:00 is at 02:00 in
// New York). The quote's own timestamp says which session it is from.

/** The calendar date in New York (YYYY-MM-DD). */
export function etIsoDate(at: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

/** The New York date of the quote's last trade, or null when the quote has
 *  no timestamp (an old cached one): then it cannot be called today's. */
export function quoteTradingDay(quote: { t?: number }): string | null {
  return quote.t && quote.t > 0 ? etIsoDate(new Date(quote.t * 1000)) : null;
}

/** True when the quote is from today's New York session. */
export function isFromTodaysSession(quote: { t?: number }, now: Date = new Date()): boolean {
  return quoteTradingDay(quote) === etIsoDate(now);
}
