// ─── v1.2 Cross-Domain Insights signal engine ───────────────────────────
//
// Pure functions that correlate already-collected data across the four
// domains (Fitness, Studies, Finance, Habits) into actionable observations.
// No new schema — everything is derived from existing Dexie tables.
//
// Design principles:
//   1. No causation claims. Observations are correlations + comparisons,
//      framed as patterns the user can decide what to do with. "On weeks
//      you trained 3+ times, you studied 27% more" — NOT "training causes
//      better study output."
//   2. 4-week baseline gate. Below 4 weeks of any input we don't show
//      observations from that stream — too small a sample. The composite
//      life score also gates at 4 weeks.
//   3. Weekly buckets (Mon-Sun ISO week). All comparisons happen at the
//      week granularity to smooth day-to-day noise.
//   4. Pure functions — every helper takes its inputs explicitly and
//      returns a plain object. Easy to test, no React-tree coupling.
//
// Inputs flow in from the store selectors (useFitnessStore.sessions,
// useStudiesStore.studySessions, useFinanceStore.transactions + budgets,
// useHabitsStore.habits + completions). The consumer (dashboard card +
// /life screen) orchestrates the call.

import type { WorkoutSession } from '../types/fitness';
import type { StudySession } from '../types/studies';
import type { Transaction, BudgetCategory } from '../types/finance';
import type { Habit, HabitCompletion } from '../types/habits';
import { isEligibleOn, dateKey } from './habitStreaks';
import { type LifeProfile, type DomainKey, weeklyTargetFor } from './lifeProfile';
import { parseDateLocal } from '@/utils/formatters';

// ─── Week bucketing ─────────────────────────────────────────────────────

/** Anchor a date to its Monday (ISO week start) at local midnight.
 *  Returns a new Date — does not mutate. Sunday is rolled to the previous
 *  Monday so the week label feels natural. */
export function startOfWeek(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  const dow = out.getDay(); // 0 Sun .. 6 Sat
  const delta = dow === 0 ? -6 : 1 - dow; // shift to Monday
  out.setDate(out.getDate() + delta);
  return out;
}

/** Generate the last N week-start dates (most recent first). */
export function lastNWeeks(n: number, today: Date = new Date()): Date[] {
  const out: Date[] = [];
  const cursor = startOfWeek(today);
  for (let i = 0; i < n; i++) {
    const d = new Date(cursor);
    d.setDate(d.getDate() - i * 7);
    out.push(d);
  }
  return out;
}

// ─── Weekly aggregates per domain ───────────────────────────────────────

interface WeeklyFitness {
  weekStart: string;       // YYYY-MM-DD Monday
  sessionsCount: number;
  totalSetCount: number;
  trainingDays: Set<string>; // YYYY-MM-DD of days that had a workout
}

interface WeeklyStudy {
  weekStart: string;
  totalMinutes: number;
  sessionCount: number;
  /** Minutes on days that ALSO had a workout vs days without. Used by the
   *  "study output on workout days vs rest days" comparison. */
  minutesOnWorkoutDays: number;
  minutesOnRestDays: number;
}

interface WeeklyFinance {
  weekStart: string;
  /** Sum of expenses across the week. Income is excluded — we're comparing
   *  spending patterns, not net cashflow. */
  expenseTotal: number;
  /** Adherence ratio: actual / proportional weekly budget. 1.0 = exactly
   *  on track, <1 = under budget, >1 = over. Month-to-date spend over the
   *  monthly limit, taken up to the end of this week — NOT this week's spend
   *  over a prorated weekly slice, which broke on any lump-sum expense (see
   *  bucketFinanceByWeek). Computed against monthly
   *  budget × 7/30. */
  budgetAdherence: number | null;
}

interface WeeklyHabits {
  weekStart: string;
  /** Total eligible (habit, date) pairs in the week. */
  eligibleCount: number;
  /** Of those, how many were "hit" (binary present OR quantified ≥target). */
  hitCount: number;
  /** Hit ratio in [0..1]. null if no eligibility this week. */
  hitRatio: number | null;
}

function inWeek(date: Date, weekStart: Date): boolean {
  const end = new Date(weekStart);
  end.setDate(end.getDate() + 7);
  return date >= weekStart && date < end;
}

function bucketFitnessByWeek(
  sessions: WorkoutSession[],
  weeks: Date[],
): WeeklyFitness[] {
  return weeks.map((w) => {
    const inThisWeek = sessions.filter((s) => inWeek(parseDateLocal(s.date), w));
    const trainingDays = new Set(inThisWeek.map((s) => s.date.slice(0, 10)));
    return {
      weekStart: dateKey(w),
      sessionsCount: inThisWeek.length,
      totalSetCount: inThisWeek.reduce((sum, s) => sum + (s.sets?.length ?? 0), 0),
      trainingDays,
    };
  });
}

function bucketStudyByWeek(
  sessions: StudySession[],
  weeks: Date[],
  fitnessWeeks: WeeklyFitness[],
): WeeklyStudy[] {
  return weeks.map((w, idx) => {
    const inThisWeek = sessions.filter((s) => inWeek(new Date(s.startedAt), w));
    const workoutDays = fitnessWeeks[idx]?.trainingDays ?? new Set<string>();
    let minutesOnWorkoutDays = 0;
    let minutesOnRestDays = 0;
    for (const s of inThisWeek) {
      const day = s.startedAt.slice(0, 10);
      if (workoutDays.has(day)) minutesOnWorkoutDays += s.durationMinutes;
      else minutesOnRestDays += s.durationMinutes;
    }
    return {
      weekStart: dateKey(w),
      totalMinutes: inThisWeek.reduce((sum, s) => sum + s.durationMinutes, 0),
      sessionCount: inThisWeek.length,
      minutesOnWorkoutDays,
      minutesOnRestDays,
    };
  });
}

function bucketFinanceByWeek(
  txns: Transaction[],
  budgets: BudgetCategory[],
  weeks: Date[],
): WeeklyFinance[] {
  const monthlyBudgetTotal = budgets.reduce((s, b) => s + b.monthlyLimit, 0);

  // A MONTHLY budget is measured against the MONTH, not against a prorated
  // slice of it. This used to divide the monthly total by 30 and compare one
  // week's spending to `monthlyTotal * 7/30`, which is wrong for the single
  // most common kind of budgeted expense: the lump sum.
  //
  // Owner's report, and it reproduces exactly: a €22/month Claude
  // subscription, logged as one €22 charge. That whole amount lands in one
  // week, so the old maths compared €22 against a €5.13 weekly slice for an
  // adherence of 4.29 — far past the 1.2 that scores 0 — and the composite
  // life score collapsed to 0 for someone who was precisely, exactly, on
  // budget. Rent, insurance and every subscription have the same shape, so
  // the failure was guaranteed rather than unlucky, and it got worse the more
  // faithfully the user logged.
  //
  // Adherence is now MONTH-TO-DATE spend over the monthly limit, taken up to
  // the end of the week being scored. €22 of a €22 budget reads 1.0 → 100.
  // €30 of it reads 1.36 → 0, which is genuinely over budget.
  //
  // No pace adjustment here, deliberately — unlike the fitness and study
  // targets above, a budget is a CAP rather than a quota to hit. Spending
  // your month's allowance in week one is being on budget, not being ahead of
  // schedule, and prorating it would resurrect the very bug this replaces.
  const expenses = txns.filter((t) => t.type === 'expense');
  return weeks.map((w) => {
    const expenseTotal = expenses
      .filter((t) => inWeek(parseDateLocal(t.date), w))
      .reduce((sum, t) => sum + t.amount, 0);

    // The month the scored week ENDS in, so a week straddling a month
    // boundary is judged against the budget period it lands in rather than
    // the one it left behind.
    const weekEnd = new Date(w);
    weekEnd.setDate(weekEnd.getDate() + 6);
    weekEnd.setHours(23, 59, 59, 999);
    const monthStart = new Date(weekEnd.getFullYear(), weekEnd.getMonth(), 1);

    const monthToDate = expenses
      .filter((t) => {
        const d = parseDateLocal(t.date);
        return d >= monthStart && d <= weekEnd;
      })
      .reduce((sum, t) => sum + t.amount, 0);

    const budgetAdherence =
      monthlyBudgetTotal > 0 ? monthToDate / monthlyBudgetTotal : null;

    return {
      weekStart: dateKey(w),
      // Still the WEEK's spend — this feeds the weekly trend, and turning it
      // into a month-to-date figure would silently change what every other
      // consumer of `expenseTotal` is showing.
      expenseTotal,
      budgetAdherence,
    };
  });
}

export function bucketHabitsByWeek(
  habits: Habit[],
  completions: HabitCompletion[],
  weeks: Date[],
): WeeklyHabits[] {
  // Pre-index completions by (habitId, date) for O(1) lookup. The completion
  // count is small (low-hundreds for a typical user) so a Map is overkill
  // but keeps the helper future-proof.
  const completionsByKey = new Map<string, number>();
  for (const c of completions) {
    completionsByKey.set(`${c.habitId}:${c.date}`, c.amount);
  }

  return weeks.map((w) => {
    let eligibleCount = 0;
    let hitCount = 0;
    // Walk each day of this week × each active habit.
    for (let dayOffset = 0; dayOffset < 7; dayOffset++) {
      const day = new Date(w);
      day.setDate(day.getDate() + dayOffset);
      const dayK = dateKey(day);
      for (const h of habits) {
        if (h.archivedAt) continue;
        // Don't count days that predate the habit's creation.
        if (day.toISOString() < h.createdAt) continue;
        if (!isEligibleOn(h, day)) continue;
        eligibleCount += 1;
        const amount = completionsByKey.get(`${h.id}:${dayK}`) ?? 0;
        const target = h.type === 'binary' ? 1 : Math.max(1, h.targetAmount ?? 1);
        if (amount >= target) hitCount += 1;
      }
    }
    return {
      weekStart: dateKey(w),
      eligibleCount,
      hitCount,
      hitRatio: eligibleCount > 0 ? hitCount / eligibleCount : null,
    };
  });
}

// ─── Insight observations ───────────────────────────────────────────────

export interface Insight {
  /** Stable key for animation / dedupe — observations rotate through this
   *  on the dashboard, so a stable id keeps the same one from cycling
   *  back-to-back. */
  id: string;
  domain: 'fitness-study' | 'fitness-finance' | 'habits-output' | 'life-score';
  /** Short headline shown big on the card. */
  headline: string;
  /** Supporting line — the "27%" / "3 of 4 weeks" detail. */
  detail: string;
  /** Polarity for tint — positive (success), negative (warning/danger),
   *  neutral (text-muted). Drives the icon/color on the card. */
  tone: 'positive' | 'negative' | 'neutral';
}

const MIN_WEEKS = 4;

/** Fitness × Studies. Compare avg study minutes on workout days vs rest
 *  days across the last MIN_WEEKS weeks. Surface only if the delta is
 *  meaningful (≥15%). */
function fitnessStudyInsight(
  studyWeeks: WeeklyStudy[],
): Insight | null {
  const recent = studyWeeks.slice(0, MIN_WEEKS);
  if (recent.length < MIN_WEEKS) return null;
  const totalWorkoutDayMin = recent.reduce((s, w) => s + w.minutesOnWorkoutDays, 0);
  const totalRestDayMin = recent.reduce((s, w) => s + w.minutesOnRestDays, 0);
  // Need a baseline of activity in both buckets to compare meaningfully.
  if (totalWorkoutDayMin < 30 || totalRestDayMin < 30) return null;
  const delta = (totalWorkoutDayMin - totalRestDayMin) / Math.max(totalRestDayMin, 1);
  if (Math.abs(delta) < 0.15) return null;
  const pct = Math.abs(Math.round(delta * 100));
  if (delta > 0) {
    return {
      id: 'fs-workout-up',
      domain: 'fitness-study',
      headline: `You study ${pct}% more on workout days`,
      detail: `Over the last ${MIN_WEEKS} weeks · ${Math.round(totalWorkoutDayMin)}m vs ${Math.round(totalRestDayMin)}m`,
      tone: 'positive',
    };
  }
  return {
    id: 'fs-workout-down',
    domain: 'fitness-study',
    headline: `You study ${pct}% less on workout days`,
    detail: `Over the last ${MIN_WEEKS} weeks · ${Math.round(totalWorkoutDayMin)}m vs ${Math.round(totalRestDayMin)}m`,
    tone: 'neutral',
  };
}

/** Fitness × Finance. Spending in high-training weeks (3+ sessions) vs
 *  low-training weeks (≤1 session). */
function fitnessFinanceInsight(
  fitnessWeeks: WeeklyFitness[],
  financeWeeks: WeeklyFinance[],
): Insight | null {
  if (fitnessWeeks.length < MIN_WEEKS) return null;
  const highWeeks: number[] = [];
  const lowWeeks: number[] = [];
  for (let i = 0; i < fitnessWeeks.length; i++) {
    const f = fitnessWeeks[i];
    const $ = financeWeeks[i];
    if (!$) continue;
    if (f.sessionsCount >= 3) highWeeks.push($.expenseTotal);
    else if (f.sessionsCount <= 1) lowWeeks.push($.expenseTotal);
  }
  if (highWeeks.length < 2 || lowWeeks.length < 2) return null;
  const avgHigh = highWeeks.reduce((s, x) => s + x, 0) / highWeeks.length;
  const avgLow = lowWeeks.reduce((s, x) => s + x, 0) / lowWeeks.length;
  if (avgHigh === 0 && avgLow === 0) return null;
  const denom = Math.max(avgLow, 1);
  const delta = (avgHigh - avgLow) / denom;
  if (Math.abs(delta) < 0.15) return null;
  const pct = Math.abs(Math.round(delta * 100));
  return {
    id: delta > 0 ? 'ff-high-spend' : 'ff-low-spend',
    domain: 'fitness-finance',
    headline:
      delta > 0
        ? `You spend ${pct}% more in high-training weeks`
        : `You spend ${pct}% less in high-training weeks`,
    detail: `${highWeeks.length} high-training weeks vs ${lowWeeks.length} low-training weeks`,
    tone: delta > 0 ? 'negative' : 'positive',
  };
}

/** Habits × Fitness/Study output. Compare study minutes + workout sessions
 *  in weeks with high habit-hit ratio vs low. Threshold = top vs bottom
 *  half of the 4-week window. */
function habitsOutputInsight(
  habitWeeks: WeeklyHabits[],
  studyWeeks: WeeklyStudy[],
  fitnessWeeks: WeeklyFitness[],
): Insight | null {
  const valid = habitWeeks
    .map((h, i) => ({ h, study: studyWeeks[i], fit: fitnessWeeks[i] }))
    .filter((x) => x.h.hitRatio != null && x.h.eligibleCount >= 3);
  if (valid.length < MIN_WEEKS) return null;
  const sorted = [...valid].sort((a, b) => (b.h.hitRatio! - a.h.hitRatio!));
  const half = Math.floor(sorted.length / 2);
  const top = sorted.slice(0, half);
  const bottom = sorted.slice(-half);
  if (top.length < 2 || bottom.length < 2) return null;

  const avgStudyTop = top.reduce((s, x) => s + x.study.totalMinutes, 0) / top.length;
  const avgStudyBottom = bottom.reduce((s, x) => s + x.study.totalMinutes, 0) / bottom.length;
  const avgFitTop = top.reduce((s, x) => s + x.fit.sessionsCount, 0) / top.length;
  const avgFitBottom = bottom.reduce((s, x) => s + x.fit.sessionsCount, 0) / bottom.length;

  // Pick whichever delta is more interesting (largest magnitude).
  const studyDelta = avgStudyBottom > 0
    ? (avgStudyTop - avgStudyBottom) / avgStudyBottom : 0;
  const fitDelta = avgFitBottom > 0
    ? (avgFitTop - avgFitBottom) / avgFitBottom : 0;
  if (Math.abs(studyDelta) < 0.15 && Math.abs(fitDelta) < 0.15) return null;
  const useStudy = Math.abs(studyDelta) >= Math.abs(fitDelta);
  const delta = useStudy ? studyDelta : fitDelta;
  const pct = Math.abs(Math.round(delta * 100));
  const target = useStudy ? 'study more' : 'train more often';
  return {
    id: useStudy ? 'ho-study' : 'ho-train',
    domain: 'habits-output',
    headline: `Hit your habits, ${target}`,
    detail:
      delta > 0
        ? `${pct}% ${useStudy ? 'more study time' : 'more sessions'} in your best habit weeks`
        : `${pct}% ${useStudy ? 'less study time' : 'fewer sessions'} in your best habit weeks`,
    tone: delta > 0 ? 'positive' : 'neutral',
  };
}

// ─── Weekly composite life score ────────────────────────────────────────

export interface LifeScore {
  weekStart: string;
  /** 0..100 composite. */
  score: number;
  /** Sub-scores (each 0..100) used to render the breakdown ring. */
  workouts: number;
  study: number;
  habits: number;
  budget: number;
  /** v1.5 — Work domain (0..100). 0 when no self-assessment data. */
  work: number;
  /** v1.5.1 — which domains actually had data this week. A domain with no
   *  data is EXCLUDED from the weighted composite (not scored 0), so an
   *  un-engaged domain doesn't drag the score down. Consumers also use this
   *  to render "—" instead of a misleading 0. */
  measured: Record<DomainKey, boolean>;
}

/** Maps a LifeProfile domain key to its computed sub-score field. */
const DOMAIN_TO_SUBSCORE: Record<DomainKey, keyof Pick<LifeScore, 'workouts' | 'study' | 'habits' | 'budget' | 'work'>> = {
  finance: 'budget',
  fitness: 'workouts',
  studies: 'study',
  work: 'work',
  habits: 'habits',
};

// v1.9 (Item 3) — the weekly workout target moved to the user's Life Profile
// and is resolved per week by `weeklyTargetFor`. The old constant 3 lives on as
// `DEFAULT_WEEKLY_WORKOUT_TARGET` there, so a profile that never set one scores
// exactly as it did before.

/** Weekly study minutes that score 100. */
const WEEKLY_STUDY_TARGET_MINUTES = 240;

/**
 * Fraction of the week that has elapsed, counting today as a whole day, so
 * Monday is 1/7 and Sunday is 7/7. Used to pace-adjust the fitness sub-score
 * for the in-progress week (see `paceFraction` on `lifeScoreForWeek`).
 *
 * Clamped to [1/7, 1]: never zero (which would divide by zero on Monday) and
 * never past a full week if the caller passes an already-closed week.
 */
function weekElapsedFraction(today: Date = new Date()): number {
  const dow = today.getDay(); // 0 Sun .. 6 Sat
  const dayIndex = dow === 0 ? 7 : dow; // Mon=1 .. Sun=7, matching startOfWeek
  return Math.min(1, Math.max(1 / 7, dayIndex / 7));
}

/**
 * Weighted composite. Each component normalizes to 0..100 against a target.
 *
 * Targets (chosen to feel attainable but not trivial):
 *   - workouts: 3 sessions/week → 100, pace-adjusted for the in-progress week
 *               via `opts.paceFraction` (see below)
 *   - study   : 240 minutes/week → 100
 *   - habits  : hit ratio 80% → 100
 *   - budget  : adherence ratio ≤ 1.0 → 100, 1.2 → 0 (linear between)
 *   - work    : supplied by computeWorkScore (opts.workScore), 0 when absent
 *
 * Weighting:
 *   - Default (no profile): equal weight across the four legacy domains
 *     (workouts/study/habits/budget) — preserves pre-v1.5 behaviour, Work
 *     excluded.
 *   - With a profile: weighted across the profile's ENABLED domains that have
 *     data this week. v1.5.1 — a domain with NO data this week (no workouts /
 *     no study / no active habits / no work log / no budgets) is EXCLUDED from
 *     the weighted denominator rather than scored 0. Rationale: a domain you
 *     haven't engaged shouldn't drag your score down — the composite reflects
 *     the areas you're actually tracking this week. (Previously these scored 0
 *     and tanked the composite, which read as a bug for users who, e.g., only
 *     track finances.)
 */
function lifeScoreForWeek(
  fit: WeeklyFitness,
  study: WeeklyStudy,
  fin: WeeklyFinance,
  habits: WeeklyHabits,
  opts?: {
    workScore?: number;
    profile?: LifeProfile;
    workHasData?: boolean;
    everUsed?: Record<DomainKey, boolean>;
    /**
     * v1.8 — fraction of the week elapsed, for the in-progress week only.
     * Omit (or pass 1) for a closed week, which scores against the full target.
     */
    paceFraction?: number;
  },
): LifeScore {
  // v1.8 — pace-adjusted fitness. This used to be `sessionsCount / 3`, which
  // scored the in-progress week against the *whole* week's target: on Wednesday
  // with 2 of 3 logged it read 67 even though the user was ahead of pace, and
  // the composite only stopped looking broken on Sunday. Now the denominator is
  // what you'd expect to have done by today, so being on pace reads as 100 all
  // week. Hitting the full weekly target early still caps at 100 rather than
  // scoring above it.
  //
  // Past weeks pass no paceFraction and keep scoring against the full target —
  // a week where you did 2 of 3 is a 67 once it's closed, and history must not
  // drift.
  const pace = Math.min(1, Math.max(1 / 7, opts?.paceFraction ?? 1));
  // v1.9 (Item 3) — the target is per-user and per-week now, not a fixed 3.
  // Resolved from the week being scored rather than from "now", so a closed
  // week keeps the target that was in force while it was lived — the same
  // no-drift rule the pace adjustment above obeys.
  const weeklyTarget = weeklyTargetFor(opts?.profile, fit.weekStart);
  const expectedSessions = weeklyTarget * pace;
  const workouts =
    fit.sessionsCount >= weeklyTarget
      ? 100
      : Math.min(100, (fit.sessionsCount / expectedSessions) * 100);
  // Same pacing treatment as workouts above. Scoring the in-progress week
  // against the full 240-minute target made the study score read artificially
  // low until Sunday — a user two days in with 70 minutes logged is on pace,
  // not at 29%. Past weeks pass no paceFraction and keep scoring against the
  // full target. The v1.8 braindump only named Fitness, so this was left then;
  // the plumbing it needs already exists.
  const expectedMinutes = WEEKLY_STUDY_TARGET_MINUTES * pace;
  const studyScore =
    study.totalMinutes >= WEEKLY_STUDY_TARGET_MINUTES
      ? 100
      : Math.min(100, (study.totalMinutes / expectedMinutes) * 100);
  const habitsScore = habits.hitRatio != null ? habits.hitRatio * 100 : 0;
  let budget = 50; // default mid when no budgets set
  if (fin.budgetAdherence != null) {
    if (fin.budgetAdherence <= 1.0) budget = 100;
    else if (fin.budgetAdherence >= 1.2) budget = 0;
    else budget = 100 * (1 - (fin.budgetAdherence - 1.0) / 0.2);
  }
  const work = Math.min(100, Math.max(0, opts?.workScore ?? 0));

  const sub = {
    workouts: Math.round(workouts),
    study: Math.round(studyScore),
    habits: Math.round(habitsScore),
    budget: Math.round(budget),
    work: Math.round(work),
  };

  // Which domains count toward the composite. v1.5.2 — the rule is "count once
  // you've EVER used it": a domain stays excluded until your first-ever log,
  // then counts every week after (so skipping a week of something you DO track
  // lowers the score — accountability). `everUsed` is supplied by the
  // orchestrator from the full history. Falls back to this-week presence for
  // any caller that doesn't pass it.
  const measured: Record<DomainKey, boolean> = opts?.everUsed ?? {
    finance: fin.budgetAdherence != null,
    fitness: fit.sessionsCount > 0,
    studies: study.sessionCount > 0,
    habits: habits.eligibleCount > 0,
    work: opts?.workHasData === true,
  };

  let score: number;
  if (opts?.profile) {
    let total = 0;
    let weightSum = 0;
    for (const key of Object.keys(opts.profile.domains) as DomainKey[]) {
      const w = opts.profile.domains[key];
      if (w <= 0) continue;
      if (!measured[key]) continue; // skip domains with no data this week
      total += sub[DOMAIN_TO_SUBSCORE[key]] * w;
      weightSum += w;
    }
    score = weightSum > 0 ? Math.round(total / weightSum) : 0;
  } else {
    score = Math.round((workouts + studyScore + habitsScore + budget) / 4);
  }

  return {
    weekStart: fit.weekStart,
    score,
    ...sub,
    measured,
  };
}

// ─── Orchestrator — pull everything together ────────────────────────────

interface CrossDomainReport {
  /** True when there's enough data (≥4 weeks) to surface any observation. */
  ready: boolean;
  /** All weekly buckets for both the dashboard rotator + /life screen. */
  weeks: {
    fitness: WeeklyFitness[];
    study: WeeklyStudy[];
    finance: WeeklyFinance[];
    habits: WeeklyHabits[];
    lifeScores: LifeScore[];
  };
  /** Ranked observations — most interesting first. */
  insights: Insight[];
}

export function buildCrossDomainReport(
  workouts: WorkoutSession[],
  studies: StudySession[],
  txns: Transaction[],
  budgets: BudgetCategory[],
  habits: Habit[],
  completions: HabitCompletion[],
  weeksWindow: number = 8,
  today: Date = new Date(),
  opts?: { profile?: LifeProfile; currentWorkScore?: number; workHasData?: boolean },
): CrossDomainReport {
  const weeks = lastNWeeks(weeksWindow, today);
  const fitness = bucketFitnessByWeek(workouts, weeks);
  const study = bucketStudyByWeek(studies, weeks, fitness);
  const finance = bucketFinanceByWeek(txns, budgets, weeks);
  const habitsW = bucketHabitsByWeek(habits, completions, weeks);
  // v1.5.2 — "ever used" per domain, from the full history. A domain counts
  // toward the score once it has any record at all; until then it's excluded
  // (so a brand-new user with only finances set up isn't dragged down by
  // domains they haven't touched).
  const everUsed: Record<DomainKey, boolean> = {
    finance: budgets.length > 0 || txns.some((t) => t.type === 'expense'),
    fitness: workouts.length > 0,
    studies: studies.length > 0,
    habits: habits.some((h) => !h.archivedAt),
    work: opts?.workHasData === true,
  };
  // The Work self-assessment is a current snapshot — historical work data
  // doesn't exist yet — so only the current week (index 0) gets the real Work
  // score; earlier weeks read 0 (the domain was inactive then). The profile
  // weighting applies to every week for a consistent composite.
  const lifeScores = weeks.map((_, i) =>
    lifeScoreForWeek(fitness[i], study[i], finance[i], habitsW[i], {
      profile: opts?.profile,
      workScore: i === 0 ? opts?.currentWorkScore ?? 0 : 0,
      workHasData: i === 0 ? opts?.workHasData === true : false,
      everUsed,
      // Only week 0 is in progress; closed weeks score against the full target.
      paceFraction: i === 0 ? weekElapsedFraction() : 1,
    }),
  );

  // Ready when we have at least 4 weeks of data across the buckets that
  // actually had ANY activity — checking only "≥4 weeks elapsed" was too
  // permissive for brand-new users who installed the app 4 weeks ago but
  // logged nothing.
  const hasActivity = (n: number) =>
    fitness.slice(0, n).some((w) => w.sessionsCount > 0) ||
    study.slice(0, n).some((w) => w.sessionCount > 0) ||
    habitsW.slice(0, n).some((w) => w.eligibleCount > 0);
  const ready = weeks.length >= MIN_WEEKS && hasActivity(MIN_WEEKS);

  const insights: Insight[] = [];
  if (ready) {
    const a = fitnessStudyInsight(study);
    if (a) insights.push(a);
    const b = fitnessFinanceInsight(fitness, finance);
    if (b) insights.push(b);
    const c = habitsOutputInsight(habitsW, study, fitness);
    if (c) insights.push(c);
  }

  return {
    ready,
    weeks: { fitness, study, finance, habits: habitsW, lifeScores },
    insights,
  };
}
