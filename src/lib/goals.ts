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

export function computeGoalProgress(goal: Goal, d: DataSources): GoalProgress {
  const currentValue = currentValueFor(goal, d);
  const percent = goal.targetValue > 0 ? (currentValue / goal.targetValue) * 100 : 0;
  const reached = currentValue >= goal.targetValue;

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
export function formatGoalValue(goal: Goal, value: number, baseCurrency: string): string {
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
      return value.toFixed(2);
    default:
      return value.toLocaleString(formatLocale());
  }
}

/** Sensible default targetValue when the user picks a goal type. */
export function defaultTargetValue(t: GoalType): number {
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
      return 4.0;
    default:
      return 0;
  }
}
