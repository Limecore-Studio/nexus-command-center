import { describe, it, expect, beforeEach } from 'vitest';
import { dismissPostedToday, postedToday } from './postedToday';

// v1.22 (NCC#294) — the "Posted today" card shows what recurring rules wrote
// for today, once per day.

const tx = (id: string, date: string, ruleId?: string) =>
  ({ id, type: 'expense', amount: 10, description: id, date, recurringRuleId: ruleId, syncStatus: 'synced', createdAt: '' }) as any;
const TODAY = '2026-11-20';

beforeEach(() => localStorage.clear());

describe('postedToday', () => {
  it("lists only today's transactions from a recurring rule", () => {
    const list = [tx('rent', TODAY, 'r1'), tx('manual', TODAY), tx('lastMonth', '2026-10-20', 'r1')];
    expect(postedToday(list, TODAY).map((t) => t.id)).toEqual(['rent']);
  });

  it('is empty for the rest of the day once dismissed, and back the next day', () => {
    const list = [tx('rent', TODAY, 'r1'), tx('rent2', '2026-11-21', 'r1')];
    dismissPostedToday(TODAY);
    expect(postedToday(list, TODAY)).toEqual([]);
    expect(postedToday(list, '2026-11-21').map((t) => t.id)).toEqual(['rent2']);
  });
});
