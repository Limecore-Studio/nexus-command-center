// Portfolio end-of-day notifications.
//
// Hybrid scheme per the v3.2 design call:
//
//   • 4:05pm ET (primary) — fires unconditionally on a US trading day. Body
//     is generic: "Markets closed — open Nexus for today's recap." Tap →
//     /finance/portfolio where live numbers are visible.
//
//   • 4:35pm ET (backup) — fires only if the user hasn't engaged with the
//     app in the 30 minutes since close. Body has the projected +%/+$
//     change baked in (computed at the time of scheduling, which happens
//     on every portfolio refresh — so by 4pm it's typically been refreshed
//     a few times that day). Tap also → /finance/portfolio.
//
//   • If the user opens the app between 4:05pm and 4:35pm ET, the backup
//     is cancelled. They've already seen the live data; firing a stale
//     "today: +X%" alert on top would just be noise.
//
//   • If the user opens the app within 5 minutes BEFORE 4:05pm (i.e.
//     they're actively in the app at close), we cancel BOTH so they don't
//     get a notification on a screen they're already looking at.
//
// US market holidays are baked into a small dated list (NYSE schedule
// through 2027). Update annually — there's no calendar API in this
// F-Droid-clean build to fetch them dynamically.
//
// Timezone: We honor America/New_York with proper EST/EDT DST handling via
// Intl.DateTimeFormat. The Date instance we hand to the LocalNotifications
// plugin is an absolute instant (the plugin reads it in the device's local
// time which converts to the same instant).

import { useFinanceStore } from '../store/useFinanceStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { cancelNotifications, ID_RANGES, scheduleNotification } from './notifications';
import { convertSync } from '../api/fxRates';
import { isFromTodaysSession } from './marketDay';

const EOD_BASE = ID_RANGES['portfolio-eod'].base;
const PRIMARY_ID = EOD_BASE + 1; // 4001 — 4:05pm ET generic
const BACKUP_ID = EOD_BASE + 2; // 4002 — 4:35pm ET with baked-in numbers

// If the user opens the app within this many ms before 4:05pm, skip the
// primary too — they're going to be looking at live data anyway.
const PRE_CLOSE_WINDOW_MS = 5 * 60 * 1000;

// US market closure dates (NYSE). Format: YYYY-MM-DD in ET.
// Refresh annually from https://www.nyse.com/markets/hours-calendars.
// Early-close days (1pm ET) are still trading days for our purposes — the
// market closes, the recap is still meaningful. Listed here only the full
// closures.
const US_MARKET_HOLIDAYS = new Set<string>([
  // 2026
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25',
  '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
  // 2027
  '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31',
  '2027-06-18', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24',
]);

// ─── Timezone helpers ────────────────────────────────────────────────────

/** Today's date in ET as a YYYY-MM-DD string. Wraps over to "tomorrow"
 *  after midnight ET even when the device is in another timezone. */
function todayInETIsoDate(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** Returns the UTC instant corresponding to "today (in ET) at HH:MM ET",
 *  accounting for EST/EDT correctly. We use the timeZoneName: 'short' field
 *  to detect EDT vs EST on the current moment — the moment we're scheduling
 *  for is the same calendar day so the offset is the same. */
function todayInETAt(hour: number, minute: number, now = new Date()): Date {
  const etDateStr = todayInETIsoDate(now);
  const tzName = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    timeZoneName: 'short',
  })
    .formatToParts(now)
    .find((p) => p.type === 'timeZoneName')?.value ?? 'EST';
  const offsetHours = tzName === 'EDT' ? -4 : -5;
  const hh = String(hour).padStart(2, '0');
  const mm = String(minute).padStart(2, '0');
  const sign = offsetHours < 0 ? '-' : '+';
  const offsetStr = `${sign}${String(Math.abs(offsetHours)).padStart(2, '0')}:00`;
  // Construct ISO string with the ET offset — Date parses it correctly into UTC.
  return new Date(`${etDateStr}T${hh}:${mm}:00${offsetStr}`);
}

function isUsTradingDay(now = new Date()): boolean {
  const etDateStr = todayInETIsoDate(now);
  if (US_MARKET_HOLIDAYS.has(etDateStr)) return false;
  // Weekday-in-ET check: format the day-of-week using en-US so we don't have
  // to convert TZ → Date arithmetic ourselves.
  const weekdayShort = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
  }).format(now);
  return weekdayShort !== 'Sat' && weekdayShort !== 'Sun';
}

// ─── Recap math ──────────────────────────────────────────────────────────

interface Recap {
  changePct: number;
  changeBase: number;
  baseCurrency: string;
}

/** Compute the portfolio's day move using current quotes vs previous close.
 *  Stocks/ETFs only — crypto's 24/7 trading makes "today's move" less
 *  meaningful, and the design call here is a US-market-close recap. Returns
 *  null if we don't have enough priced holdings to compute a baseline. */
function projectedRecap(): Recap | null {
  const state = useFinanceStore.getState();
  const baseCurrency = useSettingsStore.getState().baseCurrency;
  const rates = state.fxRates;
  let baselineValue = 0;
  let currentValue = 0;
  let anyPriced = false;
  for (const h of state.holdings) {
    if (h.assetType !== 'stock' && h.assetType !== 'etf') continue;
    const q = state.stockQuotes.find((s) => s.ticker === h.ticker);
    // pc=0 is Finnhub's "we don't know" sentinel for unsupported symbols;
    // skip rather than treat as a 100% gain.
    if (!q || !q.quote.pc) continue;
    // v1.22 (NCC#263): only quotes from today's session. A pre-open quote is
    // yesterday's move; with none from today the backup says nothing specific.
    if (!isFromTodaysSession(q.quote)) continue;
    const pcNative = q.quote.pc * h.quantity;
    const cNative = q.quote.c * h.quantity;
    const pcBase = convertSync(pcNative, q.currency, baseCurrency, rates);
    const cBase = convertSync(cNative, q.currency, baseCurrency, rates);
    if (pcBase == null || cBase == null) continue;
    baselineValue += pcBase;
    currentValue += cBase;
    anyPriced = true;
  }
  if (!anyPriced || baselineValue <= 0) return null;
  const changeBase = currentValue - baselineValue;
  const changePct = (changeBase / baselineValue) * 100;
  return { changePct, changeBase, baseCurrency };
}

function formatRecapBody(recap: Recap): string {
  const sign = recap.changeBase >= 0 ? '+' : '−';
  const pct = Math.abs(recap.changePct).toFixed(2);
  const amt = Math.abs(recap.changeBase).toFixed(2);
  // Currency symbol fallback to ISO code — keeps the body short on common ones.
  const sym =
    recap.baseCurrency === 'EUR' ? '€' :
    recap.baseCurrency === 'USD' ? '$' :
    recap.baseCurrency === 'GBP' ? '£' :
    recap.baseCurrency === 'JPY' ? '¥' :
    ` ${recap.baseCurrency}`;
  // For symbol-prefix currencies put it before the number; for the
  // fallback (` ABC`) it lands as suffix. Either reads fine.
  const symPrefix = sym.startsWith(' ') ? '' : sym;
  const symSuffix = sym.startsWith(' ') ? sym : '';
  return `Today ${sign}${pct}% · ${sign}${symPrefix}${amt}${symSuffix}`;
}

// ─── Main entry point ────────────────────────────────────────────────────

/**
 * Schedule (or re-schedule, or cancel) today's EoD alarms. Idempotent.
 *
 * Call sites:
 *   • AppShell mount, after the initial Promise.all load resolves
 *   • End of refreshPortfolio() in useFinanceStore so the backup's
 *     baked-in body uses the freshest quotes
 *   • Settings toggle (`onAfterEnable`) when the user turns Portfolio EoD on
 *
 * No-ops when:
 *   • The Settings toggle is off
 *   • Today is a weekend or US market holiday
 *   • The user has no stock/ETF holdings
 *
 * All four cases also CANCEL any previously-pending alarms so stale ones
 * from a prior session don't leak.
 */
export async function runPortfolioEodTick(): Promise<void> {
  const settings = useSettingsStore.getState();
  // Master OFF or category OFF → cancel any pending EoD alarms and bail.
  if (!settings.notifMasterEnabled || !settings.notifPortfolioEodEnabled) {
    await cancelNotifications([PRIMARY_ID, BACKUP_ID]);
    return;
  }
  const hasUsHoldings = useFinanceStore.getState().holdings.some(
    (h) => h.assetType === 'stock' || h.assetType === 'etf',
  );
  if (!hasUsHoldings) {
    await cancelNotifications([PRIMARY_ID, BACKUP_ID]);
    return;
  }
  if (!isUsTradingDay()) {
    await cancelNotifications([PRIMARY_ID, BACKUP_ID]);
    return;
  }

  const primary = todayInETAt(16, 5); // 4:05pm ET
  const backup = todayInETAt(16, 35); // 4:35pm ET
  const now = Date.now();

  // Past 4:35pm — both have either fired or are stale. Cancel to be safe.
  if (now >= backup.getTime()) {
    await cancelNotifications([PRIMARY_ID, BACKUP_ID]);
    return;
  }

  // Between 4:05pm and 4:35pm: user is in the app right now → backup is
  // unnecessary (they're seeing live data). Primary may have already fired
  // or be about to; we leave it alone (cheap idempotency — if it fired it
  // fired, if it's about to fire it'll still go through harmlessly).
  if (now >= primary.getTime()) {
    await cancelNotifications([BACKUP_ID]);
    return;
  }

  // Between primary - 5min and primary: user actively in app at close.
  // Cancel BOTH — no point showing a notification on a screen they're
  // already looking at.
  if (now >= primary.getTime() - PRE_CLOSE_WINDOW_MS) {
    await cancelNotifications([PRIMARY_ID, BACKUP_ID]);
    return;
  }

  // Default path: schedule both. Re-running this overwrites any prior
  // schedule with the same IDs so we don't accumulate orphans.
  await scheduleNotification({
    id: PRIMARY_ID,
    category: 'portfolio-eod',
    title: 'Markets closed',
    body: "Open Nexus for today's recap.",
    at: primary,
    extra: { route: '/finance/portfolio' },
  });

  // Backup uses the recap computed RIGHT NOW. If the portfolio refreshes
  // again before 4:35pm fires, this whole tick re-runs and overwrites with
  // a fresher number. By design, the body is the user's view of "today"
  // as of the most recent foreground moment — closer to truth the more
  // they engage during the day.
  const recap = projectedRecap();
  const backupBody = recap
    ? `${formatRecapBody(recap)} — tap for live numbers.`
    : "Tap for today's close.";
  await scheduleNotification({
    id: BACKUP_ID,
    category: 'portfolio-eod',
    title: 'Markets closed',
    body: backupBody,
    at: backup,
    extra: { route: '/finance/portfolio' },
  });
}
