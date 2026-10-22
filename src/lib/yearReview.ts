// Rolling 12-month review aggregator. Same data shapes as weeklyReview.ts
// but the window is the trailing 365 days from a chosen anchor date.
// "Rolling" means it's NOT calendar-aligned — opening this on June 17 shows
// you Jun 18 last year → today, which is more useful than waiting for
// Dec 31.
//
// We intentionally keep this separate from weeklyReview.ts because:
//   - The aggregations differ in shape (we want top-N rankings here, not
//     "vs prior period" deltas — comparing year-over-year is noisier and
//     less actionable for a single user).
//   - Heatmaps + per-day series matter here; weekly review is just totals.

import type { Transaction, BudgetCategory, ManualAsset, PortfolioHolding } from '../types/finance';
import type { Course, StudySession } from '../types/studies';
import type { WorkoutSession, WorkoutSet } from '../types/fitness';
import type { Task } from '../types/tasks';
import { localDateKey, parseDateLocal } from '../utils/formatters';

function inRange(iso: string | undefined, start: Date, end: Date): boolean {
  if (!iso) return false;
  const t = parseDateLocal(iso).getTime();
  return t >= start.getTime() && t <= end.getTime();
}

function topN<K>(map: Map<K, number>, n: number): Array<{ key: K; value: number }> {
  return Array.from(map.entries())
    .map(([key, value]) => ({ key, value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, n);
}

// ───────────────────────────────────────────────────────────────────────────
// Result shape
// ───────────────────────────────────────────────────────────────────────────

interface YearReviewData {
  rangeStart: Date;
  rangeEnd: Date;

  finance: {
    totalSpend: number;
    totalIncome: number;
    txCount: number;
    topCategories: Array<{ categoryId: string; total: number }>; // top 5
    spendByDay: Map<string, number>; // YYYY-MM-DD → amount
  };

  studies: {
    totalStudyMinutes: number;
    sessionCount: number;
    coursesAdded: number;
    studyMinutesByDay: Map<string, number>;
  };

  fitness: {
    workoutCount: number;
    totalSets: number;
    totalVolumeKg: number;
    topExercises: Array<{ exercise: string; sets: number }>; // top 5
    workoutsByDay: Map<string, number>;
  };

  tasks: {
    completed: number;
    created: number;
    completedByDay: Map<string, number>;
  };

  highlights: Array<{ text: string; tone: 'positive' | 'warn' | 'neutral' }>;
}

// ───────────────────────────────────────────────────────────────────────────
// Builder
// ───────────────────────────────────────────────────────────────────────────

export function buildYearReview(args: {
  anchor?: Date;
  windowDays?: number;
  transactions: Transaction[];
  budgetCategories: BudgetCategory[];
  courses: Course[];
  sessions: StudySession[];
  workouts: Array<WorkoutSession & { sets: WorkoutSet[] }>;
  tasks: Task[];
  // Unused for now but plumbed so a future "net worth at start vs end"
  // delta is cheap to add without changing this function's signature.
  holdings: PortfolioHolding[];
  manualAssets: ManualAsset[];
}): YearReviewData {
  const windowDays = args.windowDays ?? 365;
  const rangeEnd = args.anchor ?? new Date();
  rangeEnd.setHours(23, 59, 59, 999);
  const rangeStart = new Date(rangeEnd);
  rangeStart.setDate(rangeStart.getDate() - windowDays);
  rangeStart.setHours(0, 0, 0, 0);
  void args.holdings;
  void args.manualAssets;

  // Finance ─────────────────────────────────────────────
  let totalSpend = 0;
  let totalIncome = 0;
  let txCount = 0;
  const categorySpend = new Map<string, number>();
  const spendByDay = new Map<string, number>();
  for (const t of args.transactions) {
    if (!inRange(t.date, rangeStart, rangeEnd)) continue;
    txCount++;
    if (t.type === 'expense') {
      totalSpend += t.amount;
      if (t.categoryId) {
        categorySpend.set(t.categoryId, (categorySpend.get(t.categoryId) ?? 0) + t.amount);
      }
      const key = localDateKey(parseDateLocal(t.date));
      spendByDay.set(key, (spendByDay.get(key) ?? 0) + t.amount);
    } else if (t.type === 'income') {
      totalIncome += t.amount;
    }
  }
  const topCategories = topN(categorySpend, 5).map((x) => ({
    categoryId: x.key,
    total: x.value,
  }));

  // Studies ─────────────────────────────────────────────
  let totalStudyMinutes = 0;
  let sessionCount = 0;
  const studyMinutesByDay = new Map<string, number>();
  for (const s of args.sessions) {
    if (!inRange(s.startedAt, rangeStart, rangeEnd)) continue;
    totalStudyMinutes += s.durationMinutes;
    sessionCount++;
    const key = localDateKey(new Date(s.startedAt));
    studyMinutesByDay.set(key, (studyMinutesByDay.get(key) ?? 0) + s.durationMinutes);
  }
  const coursesAdded = args.courses.filter((c) => inRange(c.createdAt, rangeStart, rangeEnd)).length;

  // Fitness ─────────────────────────────────────────────
  let workoutCount = 0;
  let totalSets = 0;
  let totalVolumeKg = 0;
  const exerciseCounts = new Map<string, number>();
  const workoutsByDay = new Map<string, number>();
  for (const w of args.workouts) {
    if (!inRange(w.date, rangeStart, rangeEnd)) continue;
    workoutCount++;
    const key = localDateKey(parseDateLocal(w.date));
    workoutsByDay.set(key, (workoutsByDay.get(key) ?? 0) + 1);
    for (const set of w.sets) {
      totalSets++;
      if (set.weightKg != null && set.reps != null) totalVolumeKg += set.weightKg * set.reps;
      exerciseCounts.set(set.exercise, (exerciseCounts.get(set.exercise) ?? 0) + 1);
    }
  }
  const topExercises = topN(exerciseCounts, 5).map((x) => ({
    exercise: x.key,
    sets: x.value,
  }));

  // Tasks ───────────────────────────────────────────────
  let tasksCompleted = 0;
  let tasksCreated = 0;
  const completedByDay = new Map<string, number>();
  for (const t of args.tasks) {
    if (t.completed && inRange(t.updatedAt, rangeStart, rangeEnd)) {
      tasksCompleted++;
      const key = localDateKey(new Date(t.updatedAt));
      completedByDay.set(key, (completedByDay.get(key) ?? 0) + 1);
    }
    if (inRange(t.createdAt, rangeStart, rangeEnd)) tasksCreated++;
  }

  // Highlights — short, declarative, no overstating. Threshold-driven so
  // a slow year doesn't produce hyperbole.
  const highlights: YearReviewData['highlights'] = [];
  if (workoutCount >= 100) {
    highlights.push({
      text: `${workoutCount} workouts — averaging ~${(workoutCount / 52).toFixed(1)} per week.`,
      tone: 'positive',
    });
  } else if (workoutCount > 0) {
    highlights.push({
      text: `${workoutCount} workouts in the last 12 months.`,
      tone: 'neutral',
    });
  }
  if (totalStudyMinutes >= 6000) {
    highlights.push({
      text: `Studied ${Math.round(totalStudyMinutes / 60)} hours — serious investment.`,
      tone: 'positive',
    });
  } else if (totalStudyMinutes > 0) {
    highlights.push({
      text: `${Math.round(totalStudyMinutes / 60)} hours of focused study.`,
      tone: 'neutral',
    });
  }
  if (tasksCompleted >= 100) {
    highlights.push({ text: `${tasksCompleted} tasks completed.`, tone: 'positive' });
  }
  if (topExercises[0] && topExercises[0].sets >= 50) {
    highlights.push({
      text: `Most-trained lift: ${topExercises[0].exercise} (${topExercises[0].sets} sets).`,
      tone: 'neutral',
    });
  }
  if (highlights.length === 0) {
    highlights.push({
      text: 'Quiet 12 months. The app remembers what you logged — pick a goal for the next stretch.',
      tone: 'neutral',
    });
  }

  return {
    rangeStart,
    rangeEnd,
    finance: {
      totalSpend,
      totalIncome,
      txCount,
      topCategories,
      spendByDay,
    },
    studies: {
      totalStudyMinutes,
      sessionCount,
      coursesAdded,
      studyMinutesByDay,
    },
    fitness: {
      workoutCount,
      totalSets,
      totalVolumeKg,
      topExercises,
      workoutsByDay,
    },
    tasks: {
      completed: tasksCompleted,
      created: tasksCreated,
      completedByDay,
    },
    highlights,
  };
}
