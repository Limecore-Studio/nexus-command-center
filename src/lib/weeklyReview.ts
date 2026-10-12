// Per-module weekly aggregations + cross-module insight synthesis used by
// the Weekly Review screen and (eventually) the Sunday notification payload.
//
// Design notes:
//   - All functions are pure. Pass in the relevant data + a (start, end)
//     range. No store imports here — the screen does the dependency injection.
//   - "This week" = Mon 00:00 → Sun 23:59:59 local time. We pass weekStart
//     as a Date and derive a prior-week comparison automatically.
//   - Comparisons (vs prior week) gracefully handle empty prior-week data:
//     `prior === 0 && current > 0` reports "↑ first time" rather than "↑ ∞%".
//   - Insights are short, declarative sentences. The Weekly Review renders
//     them as bullets — no markdown, no emoji-only output.

import type { Transaction, PortfolioHolding } from '../types/finance';
import type { Course, StudySession } from '../types/studies';
import type { WorkoutSession, WorkoutSet } from '../types/fitness';
import type { Task } from '../types/tasks';
import { parseDateLocal } from '@/utils/formatters';

// ───────────────────────────────────────────────────────────────────────────
// Date helpers
// ───────────────────────────────────────────────────────────────────────────

/** Monday 00:00 local for the week containing `d`. ISO 8601 (Mon-start). */
export function startOfWeek(d: Date = new Date()): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  // getDay(): Sun=0, Mon=1, …, Sat=6. We want Mon=0 offset.
  const offset = (x.getDay() + 6) % 7;
  x.setDate(x.getDate() - offset);
  return x;
}

/** Sunday 23:59:59.999 local for the same week. */
function endOfWeek(weekStart: Date): Date {
  const x = new Date(weekStart);
  x.setDate(x.getDate() + 6);
  x.setHours(23, 59, 59, 999);
  return x;
}

function inRange(iso: string, start: Date, end: Date): boolean {
  const t = parseDateLocal(iso).getTime();
  return t >= start.getTime() && t <= end.getTime();
}

function priorWeek(weekStart: Date): { start: Date; end: Date } {
  const start = new Date(weekStart);
  start.setDate(start.getDate() - 7);
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  end.setHours(23, 59, 59, 999);
  return { start, end };
}

/** Δ string like "↑ 3 from last week" / "↓ 12%" / "first week". */
function deltaLabel(current: number, prior: number, kind: 'count' | 'pct' = 'count'): string {
  if (current === 0 && prior === 0) return '—';
  if (prior === 0) return current > 0 ? 'first time this period' : '—';
  const diff = current - prior;
  if (diff === 0) return 'same as last week';
  const arrow = diff > 0 ? '↑' : '↓';
  if (kind === 'pct') {
    const pct = Math.round((Math.abs(diff) / prior) * 100);
    return `${arrow} ${pct}% vs last week`;
  }
  return `${arrow} ${Math.abs(diff)} vs last week`;
}

// ───────────────────────────────────────────────────────────────────────────
// Per-module aggregations
// ───────────────────────────────────────────────────────────────────────────

interface FinanceWeekly {
  spend: number;
  income: number;
  txCount: number;
  topCategoryId: string | null;
  topCategoryAmount: number;
  spendDelta: string;
  priorSpend: number;
}

function aggregateFinance(
  transactions: Transaction[],
  weekStart: Date,
): FinanceWeekly {
  const weekEnd = endOfWeek(weekStart);
  const prior = priorWeek(weekStart);

  let spend = 0;
  let income = 0;
  let txCount = 0;
  const categorySpend = new Map<string, number>();
  let priorSpend = 0;

  for (const t of transactions) {
    if (inRange(t.date, weekStart, weekEnd)) {
      txCount++;
      if (t.type === 'expense') {
        spend += t.amount;
        if (t.categoryId) {
          categorySpend.set(t.categoryId, (categorySpend.get(t.categoryId) ?? 0) + t.amount);
        }
      } else if (t.type === 'income') {
        income += t.amount;
      }
    } else if (inRange(t.date, prior.start, prior.end) && t.type === 'expense') {
      priorSpend += t.amount;
    }
  }

  let topCategoryId: string | null = null;
  let topCategoryAmount = 0;
  for (const [cat, amt] of categorySpend) {
    if (amt > topCategoryAmount) {
      topCategoryId = cat;
      topCategoryAmount = amt;
    }
  }

  return {
    spend,
    income,
    txCount,
    topCategoryId,
    topCategoryAmount,
    spendDelta: deltaLabel(spend, priorSpend, 'pct'),
    priorSpend,
  };
}

interface StudiesWeekly {
  studyMinutes: number;
  sessionCount: number;
  gpa: number | null;
  minutesDelta: string;
}

function aggregateStudies(
  courses: Course[],
  sessions: StudySession[],
  weekStart: Date,
  currentGpa: number | null,
): StudiesWeekly {
  const weekEnd = endOfWeek(weekStart);
  const prior = priorWeek(weekStart);
  void courses; // Courses don't have per-week activity; included for symmetry.

  let studyMinutes = 0;
  let sessionCount = 0;
  let priorMinutes = 0;
  for (const s of sessions) {
    if (inRange(s.startedAt, weekStart, weekEnd)) {
      studyMinutes += s.durationMinutes;
      sessionCount++;
    } else if (inRange(s.startedAt, prior.start, prior.end)) {
      priorMinutes += s.durationMinutes;
    }
  }

  return {
    studyMinutes,
    sessionCount,
    gpa: currentGpa,
    minutesDelta: deltaLabel(studyMinutes, priorMinutes, 'pct'),
  };
}

interface FitnessWeekly {
  workoutCount: number;
  totalSets: number;
  totalVolumeKg: number;
  topExercise: string | null;
  topExerciseSets: number;
  workoutsDelta: string;
}

function aggregateFitness(
  sessions: (WorkoutSession & { sets: WorkoutSet[] })[],
  weekStart: Date,
): FitnessWeekly {
  const weekEnd = endOfWeek(weekStart);
  const prior = priorWeek(weekStart);

  let workoutCount = 0;
  let priorCount = 0;
  let totalSets = 0;
  let totalVolumeKg = 0;
  const exerciseCounts = new Map<string, number>();

  for (const s of sessions) {
    if (inRange(s.date, weekStart, weekEnd)) {
      workoutCount++;
      for (const set of s.sets) {
        totalSets++;
        if (set.weightKg != null && set.reps != null) {
          totalVolumeKg += set.weightKg * set.reps;
        }
        exerciseCounts.set(set.exercise, (exerciseCounts.get(set.exercise) ?? 0) + 1);
      }
    } else if (inRange(s.date, prior.start, prior.end)) {
      priorCount++;
    }
  }

  let topExercise: string | null = null;
  let topExerciseSets = 0;
  for (const [ex, c] of exerciseCounts) {
    if (c > topExerciseSets) {
      topExercise = ex;
      topExerciseSets = c;
    }
  }

  return {
    workoutCount,
    totalSets,
    totalVolumeKg,
    topExercise,
    topExerciseSets,
    workoutsDelta: deltaLabel(workoutCount, priorCount),
  };
}

interface TasksWeekly {
  completed: number;
  created: number;
  stillOpen: number;
  overdue: number;
  completedDelta: string;
}

function aggregateTasks(tasks: Task[], weekStart: Date): TasksWeekly {
  const weekEnd = endOfWeek(weekStart);
  const prior = priorWeek(weekStart);
  const now = new Date();

  let completed = 0;
  let priorCompleted = 0;
  let created = 0;
  let stillOpen = 0;
  let overdue = 0;

  for (const t of tasks) {
    if (t.completed && inRange(t.updatedAt, weekStart, weekEnd)) completed++;
    if (t.completed && inRange(t.updatedAt, prior.start, prior.end)) priorCompleted++;
    if (inRange(t.createdAt, weekStart, weekEnd)) created++;
    if (!t.completed) {
      stillOpen++;
      if (t.dueDate && parseDateLocal(t.dueDate).getTime() < now.getTime()) overdue++;
    }
  }

  return {
    completed,
    created,
    stillOpen,
    overdue,
    completedDelta: deltaLabel(completed, priorCompleted),
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Cross-module insight synthesis
// ───────────────────────────────────────────────────────────────────────────

interface WeeklyInsight {
  text: string;
  tone: 'positive' | 'warn' | 'neutral';
}

interface WeeklyReviewData {
  weekStart: Date;
  weekEnd: Date;
  finance: FinanceWeekly;
  studies: StudiesWeekly;
  fitness: FitnessWeekly;
  tasks: TasksWeekly;
  // Top-line insights drawn from cross-module patterns. 3-5 items typically.
  insights: WeeklyInsight[];
  // Portfolio total change (base currency) over the week, if we have a
  // current value — purely a "highlight" number for the Finance card.
  portfolioChangeBase: number | null;
}

export function buildWeeklyReview(args: {
  weekStart?: Date;
  transactions: Transaction[];
  courses: Course[];
  sessions: StudySession[];
  workouts: (WorkoutSession & { sets: WorkoutSet[] })[];
  tasks: Task[];
  currentGpa: number | null;
  holdings: PortfolioHolding[];
}): WeeklyReviewData {
  const weekStart = args.weekStart ?? startOfWeek();
  const weekEnd = endOfWeek(weekStart);
  void args.holdings; // reserved for portfolio P/L delta once snapshot history is queried here

  const finance = aggregateFinance(args.transactions, weekStart);
  const studies = aggregateStudies(args.courses, args.sessions, weekStart, args.currentGpa);
  const fitness = aggregateFitness(args.workouts, weekStart);
  const tasks = aggregateTasks(args.tasks, weekStart);

  const insights: WeeklyInsight[] = [];

  // Tasks vs workouts — high task volume + skipped gym is a stress proxy.
  if (tasks.completed >= 10 && fitness.workoutCount === 0) {
    insights.push({
      text: `Busy task week (${tasks.completed} done) but no workouts logged. Recovery matters too.`,
      tone: 'warn',
    });
  }

  // Strong workout week.
  if (fitness.workoutCount >= 3) {
    insights.push({
      text: `${fitness.workoutCount} workouts this week — solid consistency.`,
      tone: 'positive',
    });
  }

  // Spending vs prior week.
  if (finance.priorSpend > 0 && finance.spend > finance.priorSpend * 1.4) {
    const pct = Math.round(((finance.spend - finance.priorSpend) / finance.priorSpend) * 100);
    insights.push({
      text: `Spending up ${pct}% vs last week. Worth a glance at the top category.`,
      tone: 'warn',
    });
  } else if (finance.priorSpend > 0 && finance.spend < finance.priorSpend * 0.6) {
    insights.push({ text: `Spending down sharply vs last week — frugal stretch.`, tone: 'positive' });
  }

  // Study hours.
  if (studies.studyMinutes >= 300) {
    insights.push({
      text: `Studied ${Math.round(studies.studyMinutes / 60)}h this week. Strong push.`,
      tone: 'positive',
    });
  }

  // Overdue task warning.
  if (tasks.overdue >= 3) {
    insights.push({
      text: `${tasks.overdue} overdue tasks piling up. Block 30min to triage.`,
      tone: 'warn',
    });
  }


  // Empty-week fallback so the section never renders zero insights.
  if (insights.length === 0) {
    insights.push({
      text: `Light week across the board. A fresh slate for Monday.`,
      tone: 'neutral',
    });
  }

  return {
    weekStart,
    weekEnd,
    finance,
    studies,
    fitness,
    tasks,
    insights,
    portfolioChangeBase: null,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Notification payload formatter
// ───────────────────────────────────────────────────────────────────────────

