import { describe, it, expect, beforeEach } from 'vitest';
import { dismissReviewCard, reviewCardDue } from './reviewCard';

// v1.22 (NCC#278) — Sunday's Home card: from 16:00, once per week.

const sunday = (h: number) => new Date(2026, 10, 22, h, 0); // Sun 22 Nov 2026
beforeEach(() => localStorage.clear());

describe('reviewCardDue', () => {
  it('only on Sunday from 16:00', () => {
    expect(reviewCardDue(sunday(15))).toBe(false);
    expect(reviewCardDue(sunday(16))).toBe(true);
    expect(reviewCardDue(new Date(2026, 10, 21, 20))).toBe(false); // Saturday
  });

  it('dismissed for that Sunday, due again the next one', () => {
    dismissReviewCard(sunday(18));
    expect(reviewCardDue(sunday(21))).toBe(false);
    expect(reviewCardDue(new Date(2026, 10, 29, 17))).toBe(true);
  });
});
