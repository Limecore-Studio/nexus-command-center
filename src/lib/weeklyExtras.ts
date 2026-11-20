// v1.22 (NCC#278) — the Weekly Review's suite view: budget use, habits kept,
// study hours per course, new bests and next week's bills. Its own module, so
// the Dashboard (which builds the plain weekly summary at startup) does not
// load it; only the Weekly Review screen does.
import type { BudgetCategory, Transaction } from '../types/finance';
import type { Course, StudySession } from '../types/studies';
import type { WorkoutSession, WorkoutSet } from '../types/fitness';
import type { Habit, HabitCompletion } from '../types/habits';
import type { RecurringRule } from '../types/recurring';
import { localDateKey, parseDateLocal } from '@/utils/formatters';
import { bucketFinanceByWeek, bucketHabitsByWeek } from './crossDomainSignals';
import { occurrencesBetween } from './recurring';
import { endOfWeek, inRange } from './weeklyReview';

export interface WeeklyExtras {
  /** Month-to-date spend in this user's limited categories over their limits,
   *  as of the week's end (the Life Score's rule, NCC#253); null with none. */
  budgetUsed: number | null;
  /** Habit days kept of those due this week; null with no habit due. */
  habitsKept: { hit: number; due: number } | null;
  /** Study minutes per course this week, most first. */
  studyByCourse: { courseId: string; name: string; minutes: number }[];
  /** Exercises whose heaviest set this week beat every earlier one. */
  newBests: { exercise: string; weightKg: number }[];
  /** Expenses recurring rules will post in the seven days after the week. */
  billsNextWeek: { ruleId: string; date: string; description: string; amount: number }[];
}

/** v1.22 (NCC#278) — study minutes per course for the week. */
function studyByCourse(courses: Course[], sessions: StudySession[], start: Date, end: Date): WeeklyExtras['studyByCourse'] {
  const minutes = new Map<string, number>();
  for (const s of sessions) {
    if (!s.subjectId || !inRange(s.startedAt, start, end)) continue;
    minutes.set(s.subjectId, (minutes.get(s.subjectId) ?? 0) + s.durationMinutes);
  }
  return [...minutes]
    .map(([courseId, m]) => ({ courseId, name: courses.find((c) => c.id === courseId)?.name ?? '', minutes: m }))
    .filter((r) => r.name && r.minutes > 0)
    .sort((a, b) => b.minutes - a.minutes);
}

/** v1.22 (NCC#278) — exercises whose heaviest set this week is heavier than
 *  any set before the week. An exercise trained for the first time is not a
 *  "best" yet: there is nothing to beat. */
function newBests(sessions: (WorkoutSession & { sets: WorkoutSet[] })[], start: Date, end: Date): WeeklyExtras['newBests'] {
  const before = new Map<string, number>();
  const during = new Map<string, number>();
  for (const s of sessions) {
    const t = parseDateLocal(s.date).getTime();
    const bucket = t < start.getTime() ? before : t <= end.getTime() ? during : null;
    if (!bucket) continue;
    for (const set of s.sets) {
      if (set.weightKg == null || !(set.weightKg > 0)) continue;
      bucket.set(set.exercise, Math.max(bucket.get(set.exercise) ?? 0, set.weightKg));
    }
  }
  return [...during]
    .filter(([ex, kg]) => before.has(ex) && kg > (before.get(ex) ?? 0))
    .map(([exercise, weightKg]) => ({ exercise, weightKg }))
    .sort((a, b) => a.exercise.localeCompare(b.exercise));
}

/** v1.22 (NCC#278) — what recurring expense rules post in the seven days
 *  after `weekEnd`. Paused rules post nothing. */
function billsAfter(rules: RecurringRule[], weekEnd: Date): WeeklyExtras['billsNextWeek'] {
  const from = localDateKey(weekEnd);
  const to = new Date(weekEnd);
  to.setDate(to.getDate() + 7);
  const through = localDateKey(to);
  const out: WeeklyExtras['billsNextWeek'] = [];
  for (const r of rules) {
    if (r.pausedAt || r.kind !== 'transaction' || r.template.type !== 'expense') continue;
    for (const date of occurrencesBetween(r, from, through)) {
      out.push({ ruleId: r.id, date, description: r.template.description, amount: r.template.amount });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || b.amount - a.amount);
}

export function buildWeeklyExtras(args: {
  weekStart: Date;
  transactions: Transaction[];
  budgets: BudgetCategory[];
  userId?: string;
  courses: Course[];
  sessions: StudySession[];
  workouts: (WorkoutSession & { sets: WorkoutSet[] })[];
  habits: Habit[];
  completions: HabitCompletion[];
  rules: RecurringRule[];
}): WeeklyExtras {
  const { weekStart } = args;
  const weekEnd = endOfWeek(weekStart);
  const habitWeek = bucketHabitsByWeek(args.habits, args.completions, [weekStart])[0];
  return {
    budgetUsed: bucketFinanceByWeek(args.transactions, args.budgets, [weekStart], args.userId)[0].budgetAdherence,
    habitsKept: habitWeek && habitWeek.eligibleCount > 0 ? { hit: habitWeek.hitCount, due: habitWeek.eligibleCount } : null,
    studyByCourse: studyByCourse(args.courses, args.sessions, weekStart, weekEnd),
    newBests: newBests(args.workouts, weekStart, weekEnd),
    billsNextWeek: billsAfter(args.rules, weekEnd),
  };
}
