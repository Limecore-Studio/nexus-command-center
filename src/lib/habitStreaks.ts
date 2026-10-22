// v1.2 — Habit streak computation with grace.
//
// Rules:
//   1. A habit is "eligible" on day D if:
//      - habit.frequencyKind === 'daily', OR
//      - habit.daysOfWeek includes new Date(D).getDay()
//   2. A habit is "hit" on day D if:
//      - habit.type === 'binary'     : a completion row exists for D
//      - habit.type === 'quantified' : sum of amounts on D >= targetAmount
//   3. Streak = consecutive eligible days, walking backward from today,
//      that are either hit OR skipped under the grace allowance.
//   4. Grace allowance: at most one missed eligible day per rolling 7-day
//      window. Misses past the second within any 7d window break the streak.
//   5. We do not count days BEFORE the habit's createdAt — a habit can't
//      have a streak older than itself.
//
// Today (the local-time current day) counts as eligible-and-not-yet-broken.
// If today is eligible but not yet hit, the streak still includes everything
// up to yesterday — we don't penalize the user mid-day.
//
// Longest streak: identical logic, but scans forward from createdAt and
// tracks the max run length seen.
//
// Tests live in habitStreaks.test.ts (added with the store wiring) but the
// shape of the function is deliberately easy to assert against — all date
// math is on YYYY-MM-DD strings, no timezone surprises.

import type { Habit, HabitCompletion } from '../types/habits';

/** YYYY-MM-DD for a local-time Date. No timezone juggling. */
export function dateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Parse YYYY-MM-DD into a local-midnight Date. */
function parseDateKey(key: string): Date {
  const [y, m, d] = key.split('-').map((p) => parseInt(p, 10));
  return new Date(y, m - 1, d);
}

/** Add `days` to a date and return a new Date (does not mutate). */
function addDays(d: Date, days: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + days);
  return out;
}

/** True when this habit applies on the given date. */
export function isEligibleOn(habit: Habit, date: Date): boolean {
  if (habit.frequencyKind === 'daily') return true;
  const dow = date.getDay();
  return (habit.daysOfWeek ?? []).includes(dow);
}

/** True when the user "hit" the habit on a given date, given the completion
 *  set already filtered to this habit. For quantified habits, we sum amounts
 *  across completions for that date and compare against target. */
function isHitOn(
  habit: Habit,
  date: Date,
  completionsByDate: Map<string, number>,
): boolean {
  const key = dateKey(date);
  const amount = completionsByDate.get(key) ?? 0;
  if (habit.type === 'binary') {
    return amount > 0;
  }
  // Quantified — fall back to 1 as the implicit target if the user set the
  // habit to quantified but forgot to enter a target. Better than a silent
  // never-hits.
  const target = habit.targetAmount && habit.targetAmount > 0 ? habit.targetAmount : 1;
  return amount >= target;
}

/** Index completions by date as a sum (handles multiple rows per day in case
 *  of stale data, even though the unique index should prevent it). */
function indexByDate(rows: HabitCompletion[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) {
    out.set(r.date, (out.get(r.date) ?? 0) + r.amount);
  }
  return out;
}

export interface StreakResult {
  current: number;
  longest: number;
  /** Whether today is eligible AND already hit. Drives the "today done" pill. */
  todayHit: boolean;
  /** Whether today is eligible. Hides the pill on rest days. */
  todayEligible: boolean;
}

/**
 * Compute current + longest streaks for a habit given its completions and
 * the "today" anchor (defaults to now). Pass a fixed `today` in tests to
 * avoid wall-clock flake.
 */
export function computeStreak(
  habit: Habit,
  completions: HabitCompletion[],
  today: Date = new Date(),
): StreakResult {
  const byDate = indexByDate(completions);
  // v1.18.1 (NCC#145): the LOCAL day the habit was created. Slicing the ISO
  // timestamp gave the UTC day: west of UTC an evening habit started
  // "tomorrow" (current streak 0 after doing it), east of UTC it gained a
  // phantom missed day that used up the grace day.
  const createdAt = parseDateKey(
    /^\d{4}-\d{2}-\d{2}$/.test(habit.createdAt) ? habit.createdAt : dateKey(new Date(habit.createdAt)),
  );
  const todayKey = dateKey(today);

  // ─── Current streak ────────────────────────────────────────────────────
  // Walk backward from today. Today counts in the streak only if hit;
  // otherwise we start from yesterday and don't punish "still has time today".
  let cursor = new Date(today);
  let current = 0;
  let missesInWindow = 0;
  const todayEligible = isEligibleOn(habit, today);
  const todayHit = todayEligible && isHitOn(habit, today, byDate);

  // If today is eligible but not yet hit, start counting from yesterday so
  // mid-day reads as "streak intact, please don't break it".
  if (todayEligible && !todayHit) {
    cursor = addDays(cursor, -1);
  }

  // Rolling 7-day misses tracker — store the last 7 cursor-day decisions to
  // count misses inside the window. We just keep a queue of booleans.
  const window: boolean[] = []; // true = miss

  while (cursor >= createdAt) {
    if (!isEligibleOn(habit, cursor)) {
      // Not eligible — neither hit nor miss; skip without adding to window.
      cursor = addDays(cursor, -1);
      continue;
    }
    const hit = isHitOn(habit, cursor, byDate);
    if (hit) {
      current += 1;
      window.push(false);
      if (window.length > 7) {
        if (window.shift()) missesInWindow -= 1;
      }
    } else {
      // Eligible but missed — consult grace.
      if (missesInWindow === 0) {
        // First miss in this 7d window is forgiven. Streak continues but
        // we do NOT increment current (the miss day itself isn't a hit).
        missesInWindow += 1;
        window.push(true);
        if (window.length > 7) {
          if (window.shift()) missesInWindow -= 1;
        }
      } else {
        // Second miss inside the window → streak broken at this cursor.
        break;
      }
    }
    cursor = addDays(cursor, -1);
  }

  // ─── Longest streak ────────────────────────────────────────────────────
  // Forward scan from createdAt to today. Single pass, same grace rules.
  let longest = 0;
  let runLen = 0;
  let runMisses = 0;
  const runWindow: boolean[] = [];
  let scanCursor = new Date(createdAt);

  while (scanCursor <= today) {
    if (!isEligibleOn(habit, scanCursor)) {
      scanCursor = addDays(scanCursor, 1);
      continue;
    }
    // Don't penalize "today not hit yet" for the longest scan either.
    const isToday = dateKey(scanCursor) === todayKey;
    const hit = isHitOn(habit, scanCursor, byDate) || (isToday && !todayHit && todayEligible);
    if (hit) {
      runLen += 1;
      runWindow.push(false);
      if (runWindow.length > 7) {
        if (runWindow.shift()) runMisses -= 1;
      }
      if (runLen > longest) longest = runLen;
    } else if (runMisses === 0) {
      runMisses += 1;
      runWindow.push(true);
      if (runWindow.length > 7) {
        if (runWindow.shift()) runMisses -= 1;
      }
    } else {
      // Second miss in window — end current run.
      runLen = 0;
      runMisses = 0;
      runWindow.length = 0;
    }
    scanCursor = addDays(scanCursor, 1);
  }

  return { current, longest, todayHit, todayEligible };
}
