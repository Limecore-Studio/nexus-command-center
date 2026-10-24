// v1.19 (NCC#213) — whole report grades, ported from StudyDesk
// src/lib/reportGrade.js (StudyDesk#178), with the same tests.
//
// A DIA / German custom scale enters fine 0–15 points but the report card
// shows whole 1–6 grades (15, 14 and 13 are all a 1). StudyDesk stores the
// mapping in the account's custom scale (`user_preferences.grade_scale.custom
// .report`, plus `steps` for the named grades), and with it switched on its
// average is the credit-weighted mean of the subjects' whole report grades.
// NCC showed the fine average ("12.33/15") for the same account. This file is
// the NCC copy of the one definition: keep it in step with StudyDesk's.
//
//   convertThenAverage (default) — each grade becomes its whole grade first,
//                       and the subject is the weighted mean of those.
//   averageThenConvert — the fine values are averaged, rounded to a whole
//                       point, and that point's band is the grade.
// A subject exactly on x.5 is between two grades; it counts at x.5 and the
// overall average is then a projection.

export type ReportMethod = 'convertThenAverage' | 'averageThenConvert';

export const REPORT_METHODS: ReportMethod[] = ['convertThenAverage', 'averageThenConvert'];

export interface ReportBand { min: number; max: number; grade: number }

export interface ReportRule {
  enabled: boolean;
  method: ReportMethod;
  /** The best and worst whole grades (1 and 6 on the German scale). */
  best: number;
  worst: number;
  bands: ReportBand[];
}

export interface GradeStep { label: string; value: number }

export interface SubjectReport {
  fine: number;
  value: number;
  whole: number | null;
  between: [number, number] | null;
}

/** DIA 15-point / German 1–6 with tendencies, as StudyDesk's preset. */
export const DE15_STEPS: GradeStep[] = ([
  ['1+', 15], ['1', 14], ['1−', 13],
  ['2+', 12], ['2', 11], ['2−', 10],
  ['3+', 9], ['3', 8], ['3−', 7],
  ['4+', 6], ['4', 5], ['4−', 4],
  ['5+', 3], ['5', 2], ['5−', 1],
  ['6', 0],
] as [string, number][]).map(([label, value]) => ({ label, value }));

export const DE15_REPORT: ReportRule = {
  enabled: true,
  method: 'convertThenAverage',
  best: 1,
  worst: 6,
  bands: [
    { min: 13, max: 15, grade: 1 },
    { min: 10, max: 12, grade: 2 },
    { min: 7, max: 9, grade: 3 },
    { min: 4, max: 6, grade: 4 },
    { min: 1, max: 3, grade: 5 },
    { min: 0, max: 0, grade: 6 },
  ],
};

const finite = (v: unknown): number | null => {
  const n = typeof v === 'string' ? parseFloat(v) : (v as number);
  return Number.isFinite(n) ? n : null;
};

type Loose = Record<string, unknown> | null | undefined;

/** Steps as stored, or null. Bad entries are dropped one by one. */
export function normalizeSteps(raw: unknown): GradeStep[] | null {
  if (!Array.isArray(raw)) return null;
  const out: GradeStep[] = [];
  for (const s of raw.slice(0, 40) as Loose[]) {
    const value = finite(s?.value);
    const label = typeof s?.label === 'string' ? s.label.trim().slice(0, 6) : '';
    if (value === null || !label) continue;
    out.push({ label, value });
  }
  return out.length ? out : null;
}

/** A report definition as stored, or null when it has no usable bands. */
export function normalizeReport(raw: unknown): ReportRule | null {
  const r = raw as Loose;
  if (!r || typeof r !== 'object' || !Array.isArray(r.bands)) return null;
  const bands: ReportBand[] = [];
  for (const b of (r.bands as Loose[]).slice(0, 20)) {
    const min = finite(b?.min); const max = finite(b?.max); const grade = finite(b?.grade);
    if (min === null || max === null || grade === null) continue;
    bands.push({ min: Math.min(min, max), max: Math.max(min, max), grade });
  }
  if (!bands.length) return null;
  const grades = bands.map((b) => b.grade);
  const best = finite(r.best) ?? Math.min(...grades);
  const worst = finite(r.worst) ?? Math.max(...grades);
  return {
    enabled: r.enabled !== false,
    method: REPORT_METHODS.includes(r.method as ReportMethod) ? (r.method as ReportMethod) : REPORT_METHODS[0],
    best,
    worst,
    bands,
  };
}

/**
 * The whole report grade a fine value maps to. A value between two bands
 * (12.5 typed by hand) is rounded to the nearest point first, half up. Null
 * when no band covers it.
 */
export function bandOf(value: unknown, report: ReportRule | null): number | null {
  const n = finite(value);
  if (n === null || !report) return null;
  const point = Math.round(n);
  const hit = report.bands.find((b) => point >= b.min && point <= b.max);
  if (hit) return hit.grade;
  // Outside every band: clamp to the nearest end rather than drop the grade.
  const sorted = [...report.bands].sort((a, b) => a.min - b.min);
  if (point < sorted[0].min) return sorted[0].grade;
  if (point > sorted[sorted.length - 1].max) return sorted[sorted.length - 1].grade;
  return null;
}

// Weighted mean; weights that sum to zero mean "all equal" (subjectScore's rule).
function weightedMean(pairs: [number, number][]): number | null {
  if (!pairs.length) return null;
  const totalW = pairs.reduce((s, [, w]) => s + w, 0);
  if (totalW === 0) return pairs.reduce((s, [v]) => s + v, 0) / pairs.length;
  return pairs.reduce((s, [v, w]) => s + v * w, 0) / totalW;
}

const EPS = 1e-9;

/** A subject's report grade from its grade rows; null with no grades. */
export function subjectReport(
  grades: { grade: unknown; weight?: unknown; deletedAt?: unknown }[] | null | undefined,
  report: ReportRule | null,
): SubjectReport | null {
  const live = (grades || []).filter((g) => !g.deletedAt && finite(g.grade) !== null);
  if (!live.length || !report) return null;
  const pairs: [number, number][] = live.map((g) => [finite(g.grade) as number, finite(g.weight) ?? 0]);
  const fine = weightedMean(pairs) as number;

  let value: number | null;
  if (report.method === 'averageThenConvert') {
    value = bandOf(fine, report);
  } else {
    // A value in a gap between bands counts as 0, as it does in StudyDesk's
    // JS (null * weight). No preset has gaps; this only keeps the two equal.
    value = weightedMean(pairs.map(([v, w]) => [bandOf(v, report) ?? 0, w]));
  }
  if (value === null) return null;

  const frac = value - Math.floor(value);
  if (Math.abs(frac - 0.5) < EPS) {
    const lo = Math.floor(value); const hi = lo + 1;
    const better = report.best <= report.worst ? lo : hi;
    const worse = better === lo ? hi : lo;
    return { fine, value, whole: null, between: [better, worse] };
  }
  return { fine, value, whole: Math.round(value), between: null };
}

/**
 * The overall average: credit-weighted mean of the subjects' whole report
 * grades. A subject still at x.5 counts at x.5 and makes it a projection.
 */
export function overallReport(
  subjects: { report: SubjectReport | null; credits: number }[],
): { value: number; projection: boolean } {
  const usable = (subjects || []).filter((s) => s.report) as { report: SubjectReport; credits: number }[];
  if (!usable.length) return { value: 0, projection: false };
  const value = weightedMean(usable.map((s) => [s.report.whole ?? s.report.value, s.credits])) as number;
  return {
    value: Math.round(value * 100) / 100,
    projection: usable.some((s) => s.report.whole === null),
  };
}
