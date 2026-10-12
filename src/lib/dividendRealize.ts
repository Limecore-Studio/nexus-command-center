// Dividend auto-realize — v1.7 (BUG-2).
//
// Problem: the Portfolio screen shows projected dividend income and each
// holding's next ex-div date, but when a dividend's pay date actually passes
// the event simply drops out of the "upcoming" list — nothing ever credits the
// portfolio cash balance. Projected income silently vanishes instead of
// becoming realized cash.
//
// Fix: on every portfolio refresh, reconcile each holding's dividend events
// against the cash ledger. Any dividend whose realize date (pay date, or the
// ex-div date as a fallback when the provider omits pay date) has arrived and
// that isn't already in the ledger produces a `dividend` cash entry crediting
// perShare × quantity in the dividend's native currency.
//
// Determinism + idempotency: the entry id is derived deterministically from
// the natural key `div:<TICKER>:<exDivDate>` via legacyIdToUuid. That means:
//   - re-running the reconcile never double-credits (same id already present),
//   - the id survives a cloud round-trip unchanged (it IS the row PK — a valid
//     UUID, so legacyIdToUuid is identity on it), and
//   - two devices independently computing the same credit produce the same id,
//     so the cloud upsert collapses them instead of creating duplicates.
// (A string relatedId would be hashed on push and NOT round-trip, so id — the
// PK — is the only reliable dedupe key here.)
//
// Anchor: on first run we stamp today's date in localStorage and only realize
// dividends whose realize date is >= that anchor. Providers return the trailing
// ~12 months of dividends, so without the anchor an upgrade would dump a lump
// of historical dividends into cash on the first refresh. Going forward, each
// dividend is realized once, as its date arrives.
//
// Known simplification (acceptable for a personal tool, noted for honesty): we
// credit the holding's CURRENT quantity, not the quantity held on the ex-div
// date. If shares were bought/sold between ex-div and now the credited amount
// can be slightly off. The ledger is append-only and every entry carries a
// descriptive note, so a manual `adjust` can correct any edge case.

import type { PortfolioHolding, PortfolioCashEntry } from '../types/finance';
import type { DividendEvent } from '../api/stockDetail';
import { legacyIdToUuid } from '../utils/uuid';
import { localDateKey } from '@/utils/formatters';

const ANCHOR_KEY = 'nexus.dividendRealize.anchor.v1';

interface DividendCredit {
  /** Deterministic UUID (PK) = legacyIdToUuid(`div:<TICKER>:<exDivDate>`). */
  id: string;
  /** Stable natural key, stored on the entry for readability. */
  relatedId: string;
  ticker: string;
  /** Signed positive cash amount in `currency` (perShare × quantity). */
  amount: number;
  currency: string;
  perShare: number;
  quantity: number;
  /** The date the dividend became payable (payDate ?? exDivDate). */
  realizeDate: string;
  note: string;
}

/**
 * Read (and lazily initialise) the realize anchor — the earliest realize date
 * we'll credit. Set once, on first run, to "today" so historical dividends
 * aren't back-credited on upgrade. `now` is injectable for tests.
 */
function getDividendAnchor(now: number = Date.now()): string {
  const today = localDateKey(new Date(now));
  try {
    const existing = localStorage.getItem(ANCHOR_KEY);
    if (existing) return existing;
    localStorage.setItem(ANCHOR_KEY, today);
    return today;
  } catch {
    // No localStorage (unlikely in the WebView) — fall back to today, which
    // just means nothing before this session is retroactively credited.
    return today;
  }
}

/**
 * Compute the dividend cash credits that are now payable and not yet recorded.
 * Pure — the caller persists the returned credits (so this stays unit-testable
 * and free of store/db coupling).
 *
 * @param holdings        current portfolio holdings
 * @param dividends       ticker (upper-case) → dividend events
 * @param existingEntries current portfolio cash ledger (for id-based dedupe)
 * @param now             injectable clock
 */
export function computeDividendCredits(
  holdings: PortfolioHolding[],
  dividends: Record<string, DividendEvent[]>,
  existingEntries: PortfolioCashEntry[],
  now: number = Date.now(),
): DividendCredit[] {
  const today = localDateKey(new Date(now));
  const anchor = getDividendAnchor(now);
  const existingIds = new Set(existingEntries.map((e) => e.id));

  const credits: DividendCredit[] = [];
  const seen = new Set<string>(); // guard against duplicate events in one pass

  for (const h of holdings) {
    if (h.assetType === 'crypto') continue;
    if (!(h.quantity > 0)) continue;
    const ticker = h.ticker.toUpperCase();
    const events = dividends[ticker];
    if (!events?.length) continue;

    for (const e of events) {
      if (!(e.amount > 0)) continue;
      // Pay date is when cash actually lands; fall back to ex-div date when the
      // provider omits it. Guard against a pay date that predates ex-div (bad
      // data) by taking the later of the two.
      const realizeDate = e.payDate && e.payDate >= e.date ? e.payDate : e.date;
      if (realizeDate > today) continue; // not payable yet
      if (realizeDate < anchor) continue; // pre-feature history — skip

      const relatedId = `div:${ticker}:${e.date}`;
      const id = legacyIdToUuid(relatedId);
      if (existingIds.has(id) || seen.has(id)) continue;
      seen.add(id);

      const amount = Math.round(e.amount * h.quantity * 100) / 100;
      if (!(amount > 0)) continue;

      credits.push({
        id,
        relatedId,
        ticker,
        amount,
        currency: e.currency,
        perShare: e.amount,
        quantity: h.quantity,
        realizeDate,
        note: `Dividend · ${ticker} · ${e.amount} ${e.currency}/sh × ${h.quantity}`,
      });
    }
  }

  return credits;
}
