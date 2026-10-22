import { describe, it, expect } from 'vitest';
import { calculateGPA, inferGradeMode } from './gpa';

// v1.18.1 (NCC#165) — a 0–20 scale was read as a percentage: every subject
// under 60 scored 0 and the average showed 0.00. StudyDesk keeps its Custom
// scale on the device, not in the synced tables, so NCC infers it.

const course = (id: string, credits = 1) => ({ id, name: id, credits }) as any;
const g = (subjectId: string, grade: number, weight = 1) => ({ id: `${subjectId}${grade}`, subjectId, grade, weight }) as any;
const gpaOf = (grades: ReturnType<typeof g>[], credits: Record<string, number> = {}) => {
  const map = new Map<string, any[]>();
  for (const x of grades) map.set(x.subjectId, [...(map.get(x.subjectId) ?? []), x]);
  const courses = [...map.keys()].map((id) => course(id, credits[id] ?? 1));
  return calculateGPA(courses, map, inferGradeMode(grades));
};

describe('grade scale inference (NCC#165)', () => {
  it('a 0–20 scale is custom and scores the weighted mean', () => {
    const grades = [g('fr', 14), g('fr', 16), g('ma', 11)];
    expect(inferGradeMode(grades)).toBe('custom');
    // fr 15 × 2 credits, ma 11 × 1 → 41 / 3
    expect(gpaOf(grades, { fr: 2, ma: 1 })).toBe(13.67);
  });

  it('a perfect 20 is still custom', () => {
    expect(inferGradeMode([g('a', 20), g('b', 12)])).toBe('custom');
  });

  it('1–7 and 0–10 scales stay ib', () => {
    expect(inferGradeMode([g('a', 7), g('b', 5)])).toBe('ib');
    expect(inferGradeMode([g('a', 9.5), g('b', 4)])).toBe('ib');
    expect(gpaOf([g('a', 6), g('b', 4)])).toBe(5);
  });

  it('percentages stay us, through the 4.0 ladder', () => {
    const grades = [g('a', 95), g('b', 85), g('c', 55)];
    expect(inferGradeMode(grades)).toBe('us');
    // 4.0 + 3.0 + 0 → 7 / 3
    expect(gpaOf(grades)).toBe(2.33);
  });

  it('a percentage set with a grade just over 20 stays us', () => {
    expect(inferGradeMode([g('a', 21), g('b', 15)])).toBe('us');
  });
});
