// v1.19 — NCC#202: recurring rules, the pure part. Occurrence dates and the
// deterministic ids of generated rows. No Dexie, no store.
import type { RecurringRule } from '../types/recurring';
import { localDateKey, parseDateLocal } from '@/utils/formatters';

/** Every rule occurrence a device can generate, capped so a rule started
 *  years ago with a daily cadence can't stall the app (the rest follows on
 *  the next run). */
export const MAX_OCCURRENCES_PER_RUN = 400;

const daysInMonth = (y: number, m: number) => new Date(y, m + 1, 0).getDate();

/** The k-th occurrence (k = 0 is the start date), as a local YYYY-MM-DD. */
export function occurrenceAt(rule: Pick<RecurringRule, 'startDate' | 'every' | 'unit' | 'anchorDay'>, k: number): string {
  const start = parseDateLocal(rule.startDate);
  if (rule.unit === 'month') {
    const total = start.getMonth() + k * rule.every;
    const y = start.getFullYear() + Math.floor(total / 12);
    const m = ((total % 12) + 12) % 12;
    const anchor = rule.anchorDay ?? start.getDate();
    return localDateKey(new Date(y, m, Math.min(anchor, daysInMonth(y, m))));
  }
  const step = rule.unit === 'week' ? 7 * rule.every : rule.every;
  // Calendar arithmetic, not milliseconds: a DST change must not shift a day.
  return localDateKey(new Date(start.getFullYear(), start.getMonth(), start.getDate() + k * step));
}

/**
 * Occurrence dates after `after` (exclusive; none = from the start) up to
 * `through` (inclusive) and the rule's end date, at most `limit` of them.
 */
export function occurrencesBetween(
  rule: Pick<RecurringRule, 'startDate' | 'endDate' | 'every' | 'unit' | 'anchorDay'>,
  after: string | undefined,
  through: string,
  limit = MAX_OCCURRENCES_PER_RUN,
): string[] {
  const end = rule.endDate && rule.endDate < through ? rule.endDate : through;
  const out: string[] = [];
  // Dates are YYYY-MM-DD, so string order is date order.
  for (let k = 0; out.length < limit; k++) {
    const d = occurrenceAt(rule, k);
    if (d > end) break;
    if (after === undefined || d > after) out.push(d);
    if (k > 100_000) break; // defensive: never trust a loop over derived dates
  }
  return out;
}

/** The next occurrence after `after` (or the first), ignoring the end date
 *  only when asked; undefined once the rule has ended. */
export function nextOccurrence(
  rule: Pick<RecurringRule, 'startDate' | 'endDate' | 'every' | 'unit' | 'anchorDay'>,
  after: string | undefined,
): string | undefined {
  for (let k = 0; k <= 100_000; k++) {
    const d = occurrenceAt(rule, k);
    if (rule.endDate && d > rule.endDate) return undefined;
    if (after === undefined || d > after) return d;
  }
  return undefined;
}

// ─── Deterministic ids (RFC 4122 v5, SHA-1) ─────────────────────────────────
// Two devices materialising the same occurrence must write the same row, so
// a generated row's id is a pure function of (rule, date, part).

/** NCC's namespace for recurring occurrences (a fixed random v4). */
const NAMESPACE = '6f1d2c4e-8a3b-4b7e-9c2d-5e0f1a2b3c4d';

function uuidBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, '');
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export async function uuidv5(name: string, namespace = NAMESPACE): Promise<string> {
  const ns = uuidBytes(namespace);
  const nameBytes = new TextEncoder().encode(name);
  const buf = new Uint8Array(ns.length + nameBytes.length);
  buf.set(ns);
  buf.set(nameBytes, ns.length);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-1', buf));
  const b = hash.slice(0, 16);
  b[6] = (b[6] & 0x0f) | 0x50;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The id of one generated row: `part` tells apart the rows one occurrence
 *  writes (a buy writes a lot and a cash entry). */
export function occurrenceId(ruleId: string, date: string, part: 'tx' | 'cash' | 'lot' | 'sale' | 'redeem'): Promise<string> {
  return uuidv5(`${ruleId}:${date}:${part}`);
}
