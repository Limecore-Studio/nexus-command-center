import { describe, it, expect, vi } from 'vitest';

vi.mock('../lib/supabase', () => ({ supabase: {} }));

const { liveGpa } = await import('./gpa');
const { gpaProgress } = await import('../lib/goals');

// v1.22 (NCC#262) — no grades yet is no GPA, not 0.00.
describe('liveGpa', () => {
  it('is null while no live course has a grade', () => {
    expect(liveGpa({ calculatedGpa: 0, noGrades: true })).toBeNull();
    expect(liveGpa(null)).toBeNull();
  });

  it('is the GPA once there is one', () => {
    expect(liveGpa({ calculatedGpa: 2.4, noGrades: false })).toBe(2.4);
    expect(liveGpa({ calculatedGpa: 3.1 })).toBe(3.1);
  });

  it('a goal on a lower-is-better scale is not reached with no grades', () => {
    const down = { mode: 'custom', min: 1, max: 6, direction: 'down' } as any;
    const p = gpaProgress(liveGpa({ calculatedGpa: 0, noGrades: true }), 2, down);
    expect(p.reached).toBe(false);
    expect(p.percent).toBe(0);
  });
});
