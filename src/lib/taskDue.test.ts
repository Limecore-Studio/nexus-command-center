import { describe, it, expect } from 'vitest';
import { DATE_ONLY_HOUR, dueAtForServer, dueFromServer, dueInstant, dueLocalDate, isDateOnly } from './taskDue';

// v1.18.1 (NCC#193). Expectations are built from local Date parts, so the
// suite holds in any time zone the runner uses.

const pad = (n: number) => String(n).padStart(2, '0');
const localDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

describe('taskDue', () => {
  it('reads a date-only value as that local day at the default hour, not UTC midnight', () => {
    const d = dueInstant('2026-10-19')!;
    expect(isDateOnly('2026-10-19')).toBe(true);
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()]).toEqual([2026, 9, 19, DATE_ONLY_HOUR, 0]);
  });

  it('keeps an instant as is', () => {
    const iso = new Date(2026, 9, 19, 15, 45).toISOString();
    expect(dueInstant(iso)!.toISOString()).toBe(iso);
    expect(dueAtForServer(iso)).toBe(iso);
  });

  it('sends the local day as due_date, even when the UTC day differs', () => {
    // 01:30 local. East of UTC this is the previous day in UTC.
    const early = new Date(2026, 9, 20, 1, 30);
    expect(dueLocalDate(early.toISOString())).toBe('2026-10-20');
    // 23:30 local. West of UTC this is the next day in UTC.
    const late = new Date(2026, 9, 20, 23, 30);
    expect(dueLocalDate(late.toISOString())).toBe(localDay(late));
  });

  it('date-only values have no due_at', () => {
    expect(dueAtForServer('2026-10-19')).toBeNull();
    expect(dueLocalDate('2026-10-19')).toBe('2026-10-19');
  });

  it('a pulled row prefers due_at and falls back to due_date', () => {
    const iso = new Date(2026, 9, 19, 15, 45).toISOString();
    expect(dueFromServer({ due_at: iso, due_date: '2026-10-19' })).toBe(iso);
    // PostgREST returns timestamptz as "+00:00", not "Z".
    expect(dueFromServer({ due_at: iso.replace('Z', '+00:00'), due_date: '2026-10-19' })).toBe(iso);
    expect(dueFromServer({ due_at: null, due_date: '2026-10-19' })).toBe('2026-10-19');
    expect(dueFromServer({ due_date: null })).toBeUndefined();
  });

  it('rejects garbage', () => {
    expect(dueInstant('not a date')).toBeNull();
    expect(dueLocalDate('not a date')).toBeNull();
    expect(dueAtForServer('not a date')).toBeNull();
  });
});
