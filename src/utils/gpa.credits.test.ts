import { describe, it, expect } from 'vitest';
import { calculateGPA } from './gpa';

// v1.18.1 (NCC#160) — match StudyDesk (StudyDesk#147): a 0-credit course
// counts for nothing. NCC counted it as 1, so the two apps disagreed.

const course = (id: string, credits: unknown) => ({ id, name: id, credits }) as any;
const grades = (g: number) => [{ id: `g${g}`, grade: g, weight: 1 }] as any;

describe('calculateGPA credits (NCC#160)', () => {
  it('a 0-credit course does not move the average', () => {
    const map = new Map([['m', grades(7)], ['s', grades(1)]]);
    expect(calculateGPA([course('m', 5), course('s', 0)], map, 'ib')).toBe(7);
  });

  it('a course with no credits set counts as 1', () => {
    const map = new Map([['a', grades(6)], ['b', grades(4)]]);
    expect(calculateGPA([course('a', undefined), course('b', null)], map, 'ib')).toBe(5);
  });

  it('when every course is 0 credits, shows the plain mean', () => {
    const map = new Map([['a', grades(6)], ['b', grades(5)]]);
    expect(calculateGPA([course('a', 0), course('b', 0)], map, 'ib')).toBe(5.5);
  });
});
