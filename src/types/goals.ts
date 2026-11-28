// "Easy" goals — each backed by data already collected elsewhere in the app.
// No new logging behavior required: a goal is just a target + a cutoff date,
// and progress is computed live from the relevant module's store.
//
// Two flavours of goal:
//   - Cumulative (count events since startDate): task_count, workout_count,
//     study_hours.
//   - Absolute (reach a snapshot value): net_worth, gpa, lift_pr.
//
// v1.4 — `reading_count` was removed when the Reading Log feature was retired.
//
// Why these only: they map 1:1 to existing tables. Weight-loss, meditation,
// macro tracking etc. would require sustained logging the user doesn't do.
// Keeping v1 scoped here means deleting a goal is reversible — there's no
// schema bloat to clean up later.

import type { SyncStatus } from './finance';

export type GoalType =
  | 'net_worth'      // reach a net worth value (base currency)
  | 'task_count'     // complete N tasks since start
  | 'workout_count'  // log N workouts since start
  | 'study_hours'    // accumulate N hours of study sessions since start
  | 'lift_pr'        // reach Xkg on a specific exercise (max weightKg ever set)
  | 'gpa';           // current GPA hits or exceeds a value

export const GOAL_TYPES: readonly GoalType[] = [
  'net_worth',
  'task_count',
  'workout_count',
  'study_hours',
  'lift_pr',
  'gpa',
] as const;

// Cumulative goal types accumulate events since startDate. Absolute goal
// types reach a snapshot value (independent of startDate).
const CUMULATIVE_GOAL_TYPES: readonly GoalType[] = [
  'task_count',
  'workout_count',
  'study_hours',
] as const;

export function isCumulativeGoal(t: GoalType): boolean {
  return (CUMULATIVE_GOAL_TYPES as readonly string[]).includes(t);
}

export interface Goal {
  id: string;
  title: string;             // user-facing label
  goalType: GoalType;
  targetValue: number;
  targetDate?: string;       // YYYY-MM-DD; optional for some (lift_pr, gpa)
  startDate: string;         // YYYY-MM-DD — cutoff for cumulative counters
  // Type-specific
  exerciseName?: string;     // only for lift_pr — case-insensitive match against workoutSet.exercise
  currency?: string;         // only for net_worth — defaults to baseCurrency at creation
  // State
  completed: boolean;
  completedAt?: string;      // ISO timestamp when the user (or auto-detect) marked it done
  syncStatus: SyncStatus;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

// Labels for each goal type used in the form chips and result rows.
export const GOAL_TYPE_LABELS: Record<GoalType, { label: string; unit: string; icon: string }> = {
  net_worth: { label: 'Net Worth', unit: '€', icon: 'finance' },
  task_count: { label: 'Tasks', unit: 'tasks', icon: 'tasks' },
  workout_count: { label: 'Workouts', unit: 'workouts', icon: 'fitness' },
  study_hours: { label: 'Study Hours', unit: 'hours', icon: 'studies' },
  lift_pr: { label: 'Lift PR', unit: 'kg', icon: 'fitness' },
  gpa: { label: 'GPA', unit: '', icon: 'studies' },
};
