import { describe, it, expect } from 'vitest';
import { etIsoDate, isFromTodaysSession, quoteTradingDay } from './marketDay';

// v1.22 (NCC#263): a pre-open quote holds the previous session; it is not
// "today" for the EoD recap or the big-move alert.

describe('marketDay', () => {
  // 2026-11-25 08:00 in Helsinki is 01:00 in New York, the same date there.
  const helsinkiMorning = new Date('2026-11-25T06:00:00Z');
  const yesterdayClose = Date.parse('2026-11-24T21:00:00Z') / 1000; // 16:00 ET on the 24th
  const todayTrade = Date.parse('2026-11-25T15:00:00Z') / 1000; // 10:00 ET on the 25th

  it('dates a quote by its last trade in New York', () => {
    expect(quoteTradingDay({ t: yesterdayClose })).toBe('2026-11-24');
    expect(etIsoDate(helsinkiMorning)).toBe('2026-11-25');
  });

  it("a pre-open quote is not today's; a quote from today's session is", () => {
    expect(isFromTodaysSession({ t: yesterdayClose }, helsinkiMorning)).toBe(false);
    expect(isFromTodaysSession({ t: todayTrade }, new Date('2026-11-25T20:00:00Z'))).toBe(true);
  });

  it('a quote with no timestamp is never today', () => {
    expect(isFromTodaysSession({}, helsinkiMorning)).toBe(false);
  });
});
