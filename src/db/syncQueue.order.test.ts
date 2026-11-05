import { describe, it, expect, vi } from 'vitest';

// syncQueue imports database.ts, which reaches lib/supabase (window at module
// scope) through lib/entitlement. Same seam as database.test.ts.
vi.mock('../lib/entitlement', () => ({ clearEntitlement: vi.fn() }));
const { nextQueueTime } = await import('./syncQueue');

// Queue stamps must be strictly increasing within a session, even when the
// clock returns the same millisecond (or steps back), so pushQueue's
// createdAt sort never falls back to the random id order.
describe('nextQueueTime', () => {
  it('is strictly increasing for edits in the same millisecond', () => {
    const t = Date.parse('2030-01-01T00:00:00.000Z');
    const a = nextQueueTime(t);
    const b = nextQueueTime(t);
    const c = nextQueueTime(t);
    expect(a < b && b < c).toBe(true);
  });

  it('never goes backwards when the clock does', () => {
    const t = Date.parse('2030-01-02T00:00:00.000Z');
    const a = nextQueueTime(t);
    const b = nextQueueTime(t - 5_000);
    expect(b > a).toBe(true);
  });

  it('follows the clock again once it moves ahead', () => {
    const t = Date.parse('2030-01-03T00:00:00.000Z');
    expect(nextQueueTime(t)).toBe('2030-01-03T00:00:00.000Z');
  });
});
