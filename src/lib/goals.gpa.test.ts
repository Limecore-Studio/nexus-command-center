import { describe, it, expect, vi } from 'vitest';
import type { DataSources } from './goals';
import type { GradeScale } from './gradeScale';
import type { Goal } from '../types/goals';

vi.mock('./supabase', () => ({ supabase: {} }));

const { gpaProgress, defaultGpaTarget, defaultTargetValue, formatGoalValue, computeGoalProgress } = await import('./goals');
const { inferredScale } = await import('./gradeScale');

// v1.19 — NCC#197: a GPA goal reads its progress, its default target and its
// suffix from the account's grade scale.

const custom = (min: number, max: number, passMark: number, direction: 'up' | 'down'): GradeScale =>
  ({ mode: 'custom', min, max, passMark, direction, name: '', source: 'account' });
const US = inferredScale('us');
const IB = inferredScale('ib');
const DUTCH = custom(1, 10, 5.5, 'up');
const FOURTEN = custom(4, 10, 5, 'up');
const GERMAN = custom(1, 6, 4, 'down');

describe('gpaProgress', () => {
  it('higher-is-better scales keep current / target', () => {
    expect(gpaProgress(3, 4, US)).toEqual({ percent: 75, reached: false });
    expect(gpaProgress(6, 6, IB)).toEqual({ percent: 100, reached: true });
    expect(gpaProgress(7, 8, FOURTEN).percent).toBeCloseTo(87.5);
    expect(gpaProgress(8.2, 8, DUTCH).reached).toBe(true);
  });

  it('a lower-is-better scale measures from its worst end and is reached at or below the target', () => {
    // German 1–6, target 1.5: from 6 (worst) to 1.5.
    expect(gpaProgress(6, 1.5, GERMAN)).toEqual({ percent: 0, reached: false });
    expect(gpaProgress(3.75, 1.5, GERMAN).percent).toBeCloseTo(50);
    expect(gpaProgress(1.5, 1.5, GERMAN)).toEqual({ percent: 100, reached: true });
    expect(gpaProgress(1.2, 1.5, GERMAN)).toEqual({ percent: 100, reached: true });
    // The old reading: a 6 "met" a 1.5 target (6 >= 1.5).
    expect(gpaProgress(6, 1.5, GERMAN).reached).toBe(false);
  });

  it('no grades yet is no progress on any scale', () => {
    for (const s of [US, IB, GERMAN, FOURTEN]) expect(gpaProgress(null, 2, s)).toEqual({ percent: 0, reached: false });
  });

  it('computeGoalProgress uses it for GPA goals only', () => {
    const goal = { goalType: 'gpa', targetValue: 2, startDate: '2026-09-01' } as Goal;
    const d = { currentGpa: 2.5, gradeScale: GERMAN } as unknown as DataSources;
    const p = computeGoalProgress(goal, d);
    expect(p.reached).toBe(false);
    expect(p.percent).toBeCloseTo(((6 - 2.5) / (6 - 2)) * 100);
  });
});

describe('default target and suffix', () => {
  it('a reachable target on each scale', () => {
    expect(defaultGpaTarget(US)).toBe(3);
    expect(defaultGpaTarget(IB)).toBe(6);
    expect(defaultGpaTarget(FOURTEN)).toBe(8);
    expect(defaultGpaTarget(GERMAN)).toBe(2);
    expect(defaultTargetValue('gpa', GERMAN)).toBe(2);
    expect(defaultTargetValue('gpa')).toBe(3);
    expect(defaultTargetValue('task_count', GERMAN)).toBe(50);
  });

  it('shows the scale suffix, none for US points or a lower-is-better scale', () => {
    const goal = { goalType: 'gpa' } as Goal;
    expect(formatGoalValue(goal, 6, 'EUR', IB)).toBe('6.00/7');
    expect(formatGoalValue(goal, 8, 'EUR', FOURTEN)).toBe('8.00/10');
    expect(formatGoalValue(goal, 3, 'EUR', US)).toBe('3.00');
    expect(formatGoalValue(goal, 1.5, 'EUR', GERMAN)).toBe('1.50');
    expect(formatGoalValue(goal, 3, 'EUR')).toBe('3.00');
  });
});
