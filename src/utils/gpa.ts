import { Course, Grade } from '../types/studies';
import { overallReport, subjectReport } from '../lib/reportGrade';
import type { GradeScale } from '../lib/gradeScale';

// v1.18.1 (NCC#165): 'custom' is a points scale that is neither 1–7/0–10 nor
// a percentage — in practice 0–20 (France, Belgium, Portugal …). StudyDesk has
// a Custom mode with user-set bounds, but keeps the mode and the scale in the
// device's localStorage, not in the synced tables, so NCC cannot read them and
// only ever infers this one (see inferGradeMode). Scored like 'ib': a straight
// weighted mean, as StudyDesk scores a custom scale (StudyDesk#147).
export type GradeMode = 'us' | 'ib' | 'custom';

// ─── Per-subject score ──────────────────────────────────────────────────
// Weighted average of a subject's grades, using each grade's `weight`
// (assessment weight inside the subject — e.g. final exam = 50%).
// Returns null when the subject has no grades, so callers can skip subjects
// without grades instead of treating them as zero.
function subjectScore(grades: Grade[]): number | null {
  if (grades.length === 0) return null;
  const totalWeight = grades.reduce((s, g) => s + (g.weight || 0), 0);
  if (totalWeight === 0) {
    // All zero-weight: fall back to a simple mean so the display is non-zero
    // and the user notices the missing weights. This matches the StudyDesk
    // behavior (which treats unweighted grades as equal-weight).
    return grades.reduce((s, g) => s + g.grade, 0) / grades.length;
  }
  return grades.reduce((s, g) => s + g.grade * (g.weight || 0), 0) / totalWeight;
}

// ─── Overall GPA ────────────────────────────────────────────────────────
// Compute the overall GPA across all subjects.
//
//   - Each subject gets a single score via `subjectScore(...)`
//   - Subjects without any grades are SKIPPED (not counted toward the
//     weighted average — they contribute neither credits nor a score)
//   - Subjects' contribution is weighted by `Course.credits`
//   - For 'us' mode, each subject score is converted to a 4.0 GPA point via
//     `gradeToPoints(...)` before being weighted
//   - For 'ib' mode, the score is already on the 1–7 scale; we weight it
//     directly. 'custom' (e.g. 0–20) is weighted directly too
//
// Returns 0 when no subject has any grades — that's the displayed "blank
// state" GPA (UI also has a separate "no courses yet" empty state).
export function calculateGPA(
  courses: Course[],
  gradesBySubject: Map<string, Grade[]>,
  mode: GradeMode = 'us',
): number {
  // v1.18.1 (NCC#160): matches StudyDesk (StudyDesk#147). A course set to 0
  // credits (pass/fail) counts for nothing; `c.credits || 1` counted it as 1,
  // so the two apps showed different averages for the same synced data. A
  // course with no credits set still counts as 1, and when every graded
  // course is 0 credits the plain mean is shown rather than 0.
  const scored: { points: number; credits: number }[] = [];
  for (const c of courses) {
    const grades = gradesBySubject.get(c.id) ?? [];
    const score = subjectScore(grades);
    if (score == null) continue;
    scored.push({ points: mode === 'us' ? gradeToPoints(score) : score, credits: gpaCredits(c.credits) });
  }
  if (scored.length === 0) return 0;
  let totalCredits = scored.reduce((sum, x) => sum + x.credits, 0);
  if (totalCredits === 0) {
    for (const x of scored) x.credits = 1;
    totalCredits = scored.length;
  }
  const weightedSum = scored.reduce((sum, x) => sum + x.points * x.credits, 0);
  return Math.round((weightedSum / totalCredits) * 100) / 100;
}

/** v1.19 (NCC#213) — the average on the account's scale, as StudyDesk's
 *  overallAverage: with the report rule on, the credit-weighted mean of the
 *  subjects' whole report grades (`projection` when a subject is between two);
 *  otherwise calculateGPA. */
export function calculateScaleGPA(
  courses: Course[],
  gradesBySubject: Map<string, Grade[]>,
  scale: Pick<GradeScale, 'mode' | 'report'>,
): { gpa: number; projection: boolean } {
  const report = scale.mode === 'custom' ? scale.report ?? null : null;
  if (!report) return { gpa: calculateGPA(courses, gradesBySubject, scale.mode), projection: false };
  const { value, projection } = overallReport(courses.map((c) => ({
    report: subjectReport(gradesBySubject.get(c.id) ?? [], report),
    credits: gpaCredits(c.credits),
  })));
  return { gpa: value, projection };
}

function gpaCredits(credits: unknown): number {
  if (credits == null || credits === '') return 1;
  const n = Number(credits);
  return Number.isFinite(n) && n >= 0 ? n : 1;
}

// ─── Scale inference ────────────────────────────────────────────────────
/** Which scale a set of grades is on, for users who have never picked one.
 *
 *  `gradeToPoints` maps percentages and floors anything under 60 to 0. So a
 *  1–7 IB set — or a Finnish 4–10 set — run through it produces a weighted sum
 *  of exactly zero, and the dashboard showed **GPA 0.00 next to "6 courses"**.
 *  That is what every StudyDesk user syncing IB grades into NCC saw, because
 *  the mode defaults to 'us' and most people never open the setting.
 *
 *  Percentage grades do not sit at or below 10 in practice (a 7% subject
 *  average is not a grade anyone is carrying), so the maximum observed value
 *  is a safe discriminator. An explicit user choice always wins over this —
 *  see `load()` in useStudiesStore.
 *
 *  v1.18.1 (NCC#165): the same is true of a 0–20 scale. A French 14/20 is not
 *  14%, but above 10 it was read as a percentage, every subject under 60
 *  scored 0 and the average showed 0.00. A maximum of 20 or less is not a
 *  percentage scale either (nobody carries a 20% subject average), so it is
 *  'custom', the straight weighted mean. Anything above 20 stays 'us'. */
export function inferGradeMode(grades: Grade[]): GradeMode {
  const values = grades.map((g) => g.grade).filter((v) => Number.isFinite(v));
  if (values.length === 0) return 'us';
  const max = Math.max(...values);
  if (max <= 10) return 'ib';
  return max <= 20 ? 'custom' : 'us';
}

function gradeToPoints(grade: number): number {
  if (grade >= 93) return 4.0;
  if (grade >= 90) return 3.7;
  if (grade >= 87) return 3.3;
  if (grade >= 83) return 3.0;
  if (grade >= 80) return 2.7;
  if (grade >= 77) return 2.3;
  if (grade >= 73) return 2.0;
  if (grade >= 70) return 1.7;
  if (grade >= 67) return 1.3;
  if (grade >= 60) return 1.0;
  return 0;
}

