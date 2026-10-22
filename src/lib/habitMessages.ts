// ─── v1.5.2 Habit notification copy ──────────────────────────────────────
//
// Duolingo-style: rotating, streak-aware messages instead of a bare title.
// The variant rotates by day-of-year so the copy changes day to day but is
// deterministic (we re-pick on every app open, so it stays fresh). `{h}` is
// the habit title, `{n}` the current streak length.
//
// v1.18.1 (NCC#138): text is fixed when an alarm is scheduled. A daily habit's
// primary reminder now repeats natively and shows that same text every day
// until the app is next opened, so it uses the 'repeating' pool: no streak
// count, nothing that is only true on the day it was written.

type HabitMsgKind = 'primary' | 'repeating' | 'evening' | 'morning' | 'milestone';

interface Msg {
  title: string;
  body: string;
}

function fill(s: string, habit: string, streak: number): string {
  return s.replace(/\{h\}/g, habit).replace(/\{n\}/g, String(streak));
}

// Pools. Each entry is [title, body]. Title is short; body carries personality.
//
// v1.10: the emoji are gone from these titles. An Android notification renders
// them in the system's colour font, so the one place the app could not style a
// glyph was also the place it showed up beside the app icon. The copy carries
// the tone on its own; the milestone tiers below say what they mean in words
// rather than leaning on a trophy to grade them.
const PRIMARY_STREAK: [string, string][] = [
  ['{n}-day streak', "Keep it alive — time for {h}."],
  ['Day {n} done?', "Don't break the chain. {h} is calling."],
  ['{n} days strong', '{h} — same time, same energy.'],
  ['Streak watch: {n} days', 'One rep of consistency: {h}.'],
];
const PRIMARY_FRESH: [string, string][] = [
  ['Time for {h}', 'Small step now, big momentum later.'],
  ['{h} today', 'Start a streak today — just begin.'],
  ['Quick win available', '{h}. Two minutes of effort, all-day pride.'],
  ['Your move', '{h} is waiting. Make today count.'],
];
// v1.18.1 (NCC#138): for a reminder that repeats. True on any day whatever the
// streak: PRIMARY_STREAK states a count, and PRIMARY_FRESH's "Start a streak
// today" would be wrong once one is running.
const PRIMARY_REPEATING: [string, string][] = [
  ['Time for {h}', 'Small step now, big momentum later.'],
  ['Quick win available', '{h}. Two minutes of effort, all-day pride.'],
  ['Your move', '{h} is waiting. Make today count.'],
];
const EVENING_STREAK: [string, string][] = [
  ['Streak at risk', "Your {n}-day run on {h} isn't logged yet — still time."],
  ["Don't lose {n} days", '{h} before bed keeps the streak alive.'],
  ['Last call for {h}', "{n}-day streak on the line. You've got this."],
];
const MORNING_CATCHUP: [string, string][] = [
  ['Log last night?', 'Did you do {h}? Tap to mark it.'],
  ['Catch-up', "{h} yesterday — tap to log it if you did."],
  ['Morning check-in', 'Forgot to log {h} last night? Tap to fix it.'],
];

export function habitMessage(kind: HabitMsgKind, habit: string, streak: number, seed = dayOfYear()): Msg {
  let pool: [string, string][];
  switch (kind) {
    case 'primary':
      pool = streak > 0 ? PRIMARY_STREAK : PRIMARY_FRESH;
      break;
    case 'repeating':
      pool = PRIMARY_REPEATING;
      break;
    case 'evening':
      pool = EVENING_STREAK;
      break;
    case 'morning':
      pool = MORNING_CATCHUP;
      break;
    case 'milestone':
      return milestoneMessage(habit, streak);
  }
  const [t, b] = pool[Math.abs(seed) % pool.length];
  return { title: fill(t, habit, streak), body: fill(b, habit, streak) };
}

function milestoneMessage(habit: string, streak: number): Msg {
  // Was a trophy / 100 / star / flame tier. The word grades the milestone
  // just as well and survives a notification shade that has no colour font.
  const flair =
    streak >= 365 ? 'A full year' :
    streak >= 100 ? 'Triple digits' :
    streak >= 30 ? 'One month' : 'Milestone';
  return {
    title: `${flair} — ${streak}-day streak!`,
    body: `${streak} days of ${habit}. That's a real habit now — keep going.`,
  };
}

/** The streak lengths that trigger a one-off celebration notification. */
export const STREAK_MILESTONES = [7, 30, 100, 365] as const;

function dayOfYear(d: Date = new Date()): number {
  const start = new Date(d.getFullYear(), 0, 0);
  return Math.floor((d.getTime() - start.getTime()) / 86400000);
}
