import { Course, Grade } from '../types/studies';

export type GradeMode = 'us' | 'ib';

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
//     directly
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
 *  see `load()` in useStudiesStore. */
export function inferGradeMode(grades: Grade[]): GradeMode {
  const values = grades.map((g) => g.grade).filter((v) => Number.isFinite(v));
  if (values.length === 0) return 'us';
  return Math.max(...values) <= 10 ? 'ib' : 'us';
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

