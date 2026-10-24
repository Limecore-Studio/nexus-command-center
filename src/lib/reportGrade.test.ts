import { describe, expect, it } from 'vitest';

// v1.19 (NCC#213) — the same cases as StudyDesk src/lib/reportGrade.test.js,
// so both apps show the same average for the same account and grades.
import { DE15_REPORT, DE15_STEPS, bandOf, normalizeReport, normalizeSteps, overallReport, subjectReport } from './reportGrade';
import { parseAccountScale, gpaSuffix, meterValue } from './gradeScale';
import { calculateScaleGPA } from '../utils/gpa';
import type { Course, Grade } from '../types/studies';

const g = (grade: number, weight = 1, extra: Record<string, unknown> = {}) => ({ grade, weight, ...extra });
const avgThen = { ...DE15_REPORT, method: 'averageThenConvert' as const };

// What StudyDesk's "Germany · DIA 0–15 (1–6)" preset writes to the account.
const DIA = { v: 1, mode: 'custom', custom: { min: 0, max: 15, passMark: 5, direction: 'up', name: '', steps: DE15_STEPS, report: DE15_REPORT } };

describe('DIA 15-point bands', () => {
  it('maps every point to its whole report grade', () => {
    const expected: Record<number, number> = { 15: 1, 14: 1, 13: 1, 12: 2, 11: 2, 10: 2, 9: 3, 8: 3, 7: 3, 6: 4, 5: 4, 4: 4, 3: 5, 2: 5, 1: 5, 0: 6 };
    for (const [pts, grade] of Object.entries(expected)) expect(bandOf(Number(pts), DE15_REPORT)).toBe(grade);
  });
  it('a hand-typed half point rounds to the nearest point first', () => {
    expect(bandOf(12.5, DE15_REPORT)).toBe(1);
    expect(bandOf(12.4, DE15_REPORT)).toBe(2);
  });
});

describe('subject report grade', () => {
  it('a subject full of 2+ is a 2', () => {
    expect(subjectReport([g(12), g(12), g(12)], DE15_REPORT)).toMatchObject({ fine: 12, value: 2, whole: 2, between: null });
  });
  it('convert first (default): 13 and 12 give 1.5, between 1 and 2', () => {
    const r = subjectReport([g(13), g(12)], DE15_REPORT)!;
    expect(r.value).toBe(1.5);
    expect(r.whole).toBeNull();
    expect(r.between).toEqual([1, 2]);
    expect(r.fine).toBe(12.5);
  });
  it('average first: the same grades give 12.5 → 13 → 1', () => {
    expect(subjectReport([g(13), g(12)], avgThen)).toMatchObject({ value: 1, whole: 1, between: null });
  });
  it('weights apply to the whole grades', () => {
    expect(subjectReport([g(15, 3), g(9, 1)], DE15_REPORT)!.between).toEqual([1, 2]);
    expect(subjectReport([g(15, 1), g(9, 3)], DE15_REPORT)!.between).toEqual([2, 3]);
    expect(subjectReport([g(15, 1), g(10, 2)], DE15_REPORT)).toMatchObject({ whole: 2 });
  });
  it('no grades, or deleted ones only, is no grade', () => {
    expect(subjectReport([], DE15_REPORT)).toBeNull();
    expect(subjectReport([g(12, 1, { deletedAt: 'x' })], DE15_REPORT)).toBeNull();
  });
});

describe('overall report average', () => {
  it('credit-weighted mean of whole report grades', () => {
    expect(overallReport([
      { report: subjectReport([g(12)], DE15_REPORT), credits: 2 },
      { report: subjectReport([g(14)], DE15_REPORT), credits: 1 },
    ])).toEqual({ value: 1.67, projection: false });
  });
  it('a subject still between two grades counts at x.5 and makes it a projection', () => {
    expect(overallReport([
      { report: subjectReport([g(13), g(12)], DE15_REPORT), credits: 1 },
      { report: subjectReport([g(11)], DE15_REPORT), credits: 1 },
    ])).toEqual({ value: 1.75, projection: true });
  });
  it('rejects a report with no usable bands, and junk steps', () => {
    expect(normalizeReport({ bands: [{ min: 'x' }] })).toBeNull();
    expect(normalizeReport(null)).toBeNull();
    expect(normalizeSteps([{ label: '', value: 1 }, { label: '2+', value: 'x' }])).toBeNull();
  });
});

describe('the account scale carries the report rule', () => {
  it('DIA: shown on 1–6, lower is better, pass 4', () => {
    const s = parseAccountScale(DIA)!;
    expect(s).toMatchObject({ mode: 'custom', min: 1, max: 6, passMark: 4, direction: 'down' });
    expect(s.report).toEqual(normalizeReport(DE15_REPORT));
    expect(gpaSuffix(s)).toBe('');
    expect(meterValue(1, s)).toBe(6);
  });
  it('rule switched off: the fine 0–15 scale, exactly as before', () => {
    const off = { ...DIA, custom: { ...DIA.custom, report: { ...DE15_REPORT, enabled: false } } };
    const s = parseAccountScale(off)!;
    expect(s).toMatchObject({ min: 0, max: 15, passMark: 5, direction: 'up' });
    expect(s.report).toBeUndefined();
  });
});

describe('calculateScaleGPA: the number NCC shows', () => {
  const course = (id: string, credits = 1) => ({ id, importId: 'cloud', name: id, credits, createdAt: '' }) as Course;
  const grade = (subjectId: string, value: number) => ({ id: subjectId + value, subjectId, grade: value, weight: 1 }) as Grade;
  const courses = [course('a'), course('b')];
  const idx = new Map([['a', [grade('a', 12)]], ['b', [grade('b', 14)]]]);

  it('report grades when the rule is on (StudyDesk shows 1.5)', () => {
    expect(calculateScaleGPA(courses, idx, parseAccountScale(DIA)!)).toEqual({ gpa: 1.5, projection: false });
  });
  it('a projection when a subject is between two grades', () => {
    const between = new Map([['a', [grade('a', 13), grade('a', 12)]], ['b', [grade('b', 11)]]]);
    expect(calculateScaleGPA(courses, between, parseAccountScale(DIA)!)).toEqual({ gpa: 1.75, projection: true });
  });
  it('the fine average when it is off, or on another mode', () => {
    const off = parseAccountScale({ ...DIA, custom: { ...DIA.custom, report: { ...DE15_REPORT, enabled: false } } })!;
    expect(calculateScaleGPA(courses, idx, off)).toEqual({ gpa: 13, projection: false });
    expect(calculateScaleGPA(courses, idx, { mode: 'ib', report: DE15_REPORT })).toEqual({ gpa: 13, projection: false });
  });
});
