import i18n from '../i18n';

/** The formatting locale, deliberately not the same value as the i18n resource
 *  language. i18n resolves to a bare code ('en'); the device reports a region
 *  ('en-GB', 'en-IN', 'pt-BR'). When the two agree on language, prefer the
 *  device's regional tag — that is what gives an Indian user lakh/crore digit
 *  grouping (12,34,567) rather than the Western 1,234,567.
 *
 *  Every display formatter in the app routes through this. They were hardcoded
 *  to 'fi-FI' across ~30 sites, so every user in every language got Finnish
 *  number and date conventions: "1 234,56" with a space thousands separator,
 *  and "26.7.2026" dates.
 *
 *  Read per call rather than cached: the language can change at runtime, and
 *  callers are re-invoked on the re-render that i18next triggers. */
export function formatLocale(): string {
  const lang = (i18n.language || 'en').split('-')[0];
  const nav = (typeof navigator !== 'undefined'
    && (navigator.languages?.[0] || navigator.language)) || '';
  return nav.split('-')[0] === lang ? nav : lang;
}

/** Localised weekday names, indexed 0 = Sunday to match Date.getDay().
 *  Built from a known week (2024-01-07 was a Sunday) so every locale gets
 *  correct names without a key per language. */
export function weekdayNames(style: 'long' | 'short' | 'narrow'): string[] {
  const fmt = new Intl.DateTimeFormat(formatLocale(), { weekday: style });
  return Array.from({ length: 7 }, (_, i) => fmt.format(new Date(2024, 0, 7 + i)));
}

/** Localised month names, indexed 0 = January to match Date.getMonth(). */
export function monthNames(style: 'long' | 'short' | 'narrow'): string[] {
  const fmt = new Intl.DateTimeFormat(formatLocale(), { month: style });
  return Array.from({ length: 12 }, (_, i) => fmt.format(new Date(2024, i, 1)));
}

export function formatCurrency(amount: number, currency = 'EUR'): string {
  return new Intl.NumberFormat(formatLocale(), {
    style: 'currency', currency, minimumFractionDigits: 2,
  }).format(amount);
}

/** v1.18.1 (NCC#145) — a stored date as a Date in LOCAL time. A date-only
 *  "YYYY-MM-DD" is local midnight; `new Date("YYYY-MM-DD")` is UTC midnight,
 *  which west of UTC is the previous evening, so this week's Monday expense
 *  counted as last week and "days left" came out one short. A full timestamp
 *  is parsed as before. A date that does not exist ("2026-02-31") is an
 *  Invalid Date, as `new Date` makes it, rather than rolling into March. */
export function parseDateLocal(s: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return new Date(s);
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.getMonth() === Number(m[2]) - 1 ? d : new Date(NaN);
}

/**
 * Local-time YYYY-MM-DD bucket key for a Date. Used as the grouping key
 * across modules so a transaction logged at 23:59 in Europe/Helsinki goes
 * into today's bucket, not tomorrow's (which `toISOString().slice(0,10)`
 * would do in UTC).
 */
export function localDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Short date — "26 Jul", "26 heinäk.", "२६ जुल".
 *
 *  NC-1 routed ~30 hardcoded `fi-FI` sites through formatLocale() and missed
 *  this one, which is live in three screens: transaction dates on the Finance
 *  overview, task due-date pills, and the cash-flow forecast. So the bug NC-1
 *  set out to fix — every user in every language getting Finnish date
 *  conventions — survived in exactly those places.
 *
 *  Its three neighbours (`formatDate`, `formatTime`, `formatPercent`) had no
 *  callers at all and were deleted rather than fixed. Two of them were also
 *  hardcoded to `fi-FI`, so leaving them would have left a loaded trap: the
 *  next person needing a date formatter would have reached for one and
 *  reintroduced the whole defect. */
export function formatShortDate(iso: string): string {
  return new Intl.DateTimeFormat(formatLocale(), { day: '2-digit', month: 'short' })
    .format(parseDateLocal(iso));
}

export function formatCacheAge(minutes: number): string {
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${Math.round(minutes)}m old`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return m > 0 ? `${h}h ${m}m old` : `${h}h old`;
}

export function isToday(iso: string): boolean {
  const d = parseDateLocal(iso);
  const t = new Date();
  return d.getFullYear() === t.getFullYear() && d.getMonth() === t.getMonth() && d.getDate() === t.getDate();
}

export function isOverdue(iso: string): boolean {
  return parseDateLocal(iso) < new Date() && !isToday(iso);
}

/**
 * Format an instant for a `<input type="datetime-local">` value.
 *
 * v1.10.1 bug fix. The obvious version of this is
 * `new Date(iso).toISOString().slice(0, 16)`, and it is wrong in a way that
 * only shows up outside UTC: `toISOString()` converts to UTC, while the input
 * interprets whatever string it is given as LOCAL time. Editing a task due at
 * 15:00 in Helsinki (UTC+3 in summer) therefore reopened showing 12:00 — the
 * reported "the time doesn't save, it shows 12.00 every time".
 *
 * Worse than cosmetic: whatever the field showed was what got saved on the
 * next submit, so each edit round-trip silently shifted the deadline by the
 * UTC offset again. The only timezone where the naive version is correct is
 * the one nobody develops in by accident.
 *
 * Reading the local components back out is the fix — there is no built-in
 * that formats an instant as a local ISO-shaped string.
 */
export function toDateTimeLocalValue(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}
