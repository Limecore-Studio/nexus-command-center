// Live progress computation for goals. Every goal type maps to a single
// existing data source (no new logging), and progress is a pure function
// of that data + the goal's parameters. No state stored on the goal row
// — progress is always derived, so editing a workout or undoing a task
// instantly reflects in the goal's progress bar.

import type { Goal, GoalType } from '../types/goals';
import { formatLocale, parseDateLocal } from '../utils/formatters';
import { isCumulativeGoal } from '../types/goals';
import type { Transaction, PortfolioHolding, PortfolioLot, ManualAsset } from '../types/finance';
import { LIABILITY_TYPES, isManuallyPriced } from '../types/finance';
import { manualHoldingValueBase } from './manualValuation';
import type { StudySession } from '../types/studies';
import type { WorkoutSession, WorkoutSet } from '../types/fitness';
import type { Task } from '../types/tasks';
import { convertSync, normalizeCurrency } from '../api/fxRates';
import { gpaSuffix, type GradeScale } from './gradeScale';

export interface DataSources {
  transactions: Transaction[];
  holdings: PortfolioHolding[];
  /** v1.19 (NCC#204): a bond's book value is per lot. */
  portfolioLots?: PortfolioLot[];
  manualAssets: ManualAsset[];
  // Quote + price data needed to value the portfolio in base currency.
  stockQuotes: Array<{ ticker: string; quote: { c: number }; currency: string }>;
  cryptoPrices: { prices: Array<{ id: string; priceEur: number }> } | null;
  fxRates: Record<string, number> | null;
  baseCurrency: string;
  tasks: Task[];
  studySessions: StudySession[];
  workouts: Array<WorkoutSession & { sets: WorkoutSet[] }>;
  currentGpa: number | null;
  /** v1.19 (NCC#197): the account's grade scale; a GPA goal reads progress
   *  in its direction. Absent = a 0–4-style higher-is-better scale. */
  gradeScale?: GradeScale;
}

interface GoalProgress {
  currentValue: number;
  // % of target [0, 100+]. >100 means goal exceeded — UI still clamps the
  // bar but lets the number text say "118%".
  percent: number;
  daysRemaining: number | null;   // null if goal has no targetDate
  // For cumulative goals: positive means ahead of pace, negative behind.
  // For absolute goals: always null (no pace concept without a deadline).
  paceDelta: number | null;
  // True the moment currentValue >= targetValue. The goal isn't marked
  // completed automatically — the user does that — but the UI uses this to
  // suggest "Mark complete?" once the threshold is crossed.
  reached: boolean;
}

function netWorthBase(d: DataSources): number {
  let portfolioBase = 0;
  for (const h of d.holdings) {
    if (isManuallyPriced(h.assetType)) {
      // v1.19 (NCC#204): bonds and custom holdings carry their own price.
      const v = manualHoldingValueBase(h, d.portfolioLots ?? [], d.fxRates, d.baseCurrency);
      if (v != null) portfolioBase += v;
    } else if (h.assetType === 'stock' || h.assetType === 'etf') {
      const q = d.stockQuotes.find((s) => s.ticker === h.ticker);
      if (!q) continue;
      const native = normalizeCurrency(q.quote.c * h.quantity, q.currency);
      const conv = convertSync(native.amount, native.currency, d.baseCurrency, d.fxRates);
      if (conv != null) portfolioBase += conv;
    } else {
      const p = d.cryptoPrices?.prices.find((p) => p.id === h.ticker);
      if (!p) continue;
      const native = p.priceEur * h.quantity;
      const conv = d.baseCurrency === 'EUR' ? native : convertSync(native, 'EUR', d.baseCurrency, d.fxRates);
      if (conv != null) portfolioBase += conv;
    }
  }
  let assets = 0;
  let liab = 0;
  for (const a of d.manualAssets) {
    const conv = convertSync(a.value, a.currency, d.baseCurrency, d.fxRates);
    if (conv == null) continue;
    if (LIABILITY_TYPES.includes(a.assetType)) liab += conv;
    else assets += conv;
  }
  return portfolioBase + assets - liab;
}

function currentValueFor(goal: Goal, d: DataSources): number {
  const start = parseDateLocal(goal.startDate).getTime();
  switch (goal.goalType) {
    case 'net_worth':
      return netWorthBase(d);

    case 'task_count':
      return d.tasks.filter(
        (t) => t.completed && new Date(t.updatedAt).getTime() >= start,
      ).length;

    case 'workout_count':
      return d.workouts.filter((w) => parseDateLocal(w.date).getTime() >= start).length;

    case 'study_hours': {
      const minutes = d.studySessions
        .filter((s) => new Date(s.startedAt).getTime() >= start)
        .reduce((sum, s) => sum + s.durationMinutes, 0);
      return Math.round((minutes / 60) * 10) / 10; // 1 decimal
    }

    case 'lift_pr': {
      // Max weightKg across all sets matching this exercise (case-insensitive).
      // We DON'T filter by startDate — a PR is a PR regardless of when set.
      const target = (goal.exerciseName ?? '').toLowerCase().trim();
      if (!target) return 0;
      let maxKg = 0;
      for (const w of d.workouts) {
        for (const set of w.sets) {
          if (set.exercise.toLowerCase().trim() === target && set.weightKg != null && set.weightKg > maxKg) {
            maxKg = set.weightKg;
          }
        }
      }
      return maxKg;
    }

    case 'gpa':
      return d.currentGpa ?? 0;

    default:
      return 0;
  }
}

/**
 * v1.19 (NCC#197): a GPA goal on its own scale. Higher-is-better keeps the
 * plain current/target reading. Lower-is-better (German, Czech 1–6) measures
 * from the scale's worst end, (worst − current) / (worst − target), and is
 * reached at or below the target. No grades yet is no progress on any scale
 * (a missing GPA reads as 0, which on a 1–6 scale would beat every target).
 */
export function gpaProgress(current: number | null, target: number, scale?: GradeScale): { percent: number; reached: boolean } {
  if (current == null) return { percent: 0, reached: false };
  if (scale?.direction === 'down') {
    const worst = scale.max;
    const span = worst - target;
    const percent = span > 0 ? ((worst - current) / span) * 100 : current <= target ? 100 : 0;
    return { percent: Math.max(0, Math.min(100, percent)), reached: current <= target };
  }
  return { percent: target > 0 ? (current / target) * 100 : 0, reached: current >= target };
}

export function computeGoalProgress(goal: Goal, d: DataSources): GoalProgress {
  const currentValue = currentValueFor(goal, d);
  const gpa = goal.goalType === 'gpa' ? gpaProgress(d.currentGpa, goal.targetValue, d.gradeScale) : null;
  const percent = gpa ? gpa.percent : goal.targetValue > 0 ? (currentValue / goal.targetValue) * 100 : 0;
  const reached = gpa ? gpa.reached : currentValue >= goal.targetValue;

  let daysRemaining: number | null = null;
  let paceDelta: number | null = null;
  if (goal.targetDate) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const target = parseDateLocal(goal.targetDate);
    target.setHours(0, 0, 0, 0);
    daysRemaining = Math.max(0, Math.ceil((target.getTime() - today.getTime()) / 86400000));

    if (isCumulativeGoal(goal.goalType)) {
      const start = parseDateLocal(goal.startDate);
      start.setHours(0, 0, 0, 0);
      const totalDays = Math.max(1, Math.ceil((target.getTime() - start.getTime()) / 86400000));
      const elapsedDays = Math.max(0, Math.ceil((today.getTime() - start.getTime()) / 86400000));
      const expected = goal.targetValue * (elapsedDays / totalDays);
      // paceDelta = current minus expected. Positive = ahead.
      paceDelta = currentValue - expected;
    }
  }

  return { currentValue, percent, daysRemaining, paceDelta, reached };
}

/** Pretty-print the target value with its unit. */
export function formatGoalValue(goal: Goal, value: number, baseCurrency: string, scale?: GradeScale): string {
  switch (goal.goalType) {
    case 'net_worth':
      return new Intl.NumberFormat(formatLocale(), {
        style: 'currency',
        currency: goal.currency ?? baseCurrency,
        maximumFractionDigits: 0,
      }).format(value);
    case 'lift_pr':
      return `${value} kg`;
    case 'study_hours':
      return `${value.toFixed(1)} h`;
    case 'gpa':
      // v1.19 (NCC#197): with the scale's suffix ("/7", "/20"; none for
      // US points or a lower-is-better scale).
      return value.toFixed(2) + (scale ? gpaSuffix(scale) : '');
    default:
      return value.toLocaleString(formatLocale());
  }
}

/** Sensible default targetValue when the user picks a goal type. */
/** v1.19 (NCC#197): a GPA target worth aiming for on this scale: the pass
 *  mark plus 60% of the way to the best grade, to the nearest half. 3.0 on
 *  US points, 6 on IB 1–7, 2.0 on German 1–6, 8 on 4–10. */
export function defaultGpaTarget(scale?: GradeScale): number {
  if (!scale) return 3.0;
  const best = scale.direction === 'down' ? scale.min : scale.max;
  const raw = scale.passMark + 0.6 * (best - scale.passMark);
  return Math.round(raw * 2) / 2;
}

export function defaultTargetValue(t: GoalType, scale?: GradeScale): number {
  switch (t) {
    case 'net_worth':
      return 50_000;
    case 'task_count':
      return 50;
    case 'workout_count':
      return 30;
    case 'study_hours':
      return 100;
    case 'lift_pr':
      return 100;
    case 'gpa':
      return defaultGpaTarget(scale);
    default:
      return 0;
  }
}
