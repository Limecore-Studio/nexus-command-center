-- NCC v1.14 — goal-linked habit tracking without a streak mechanic.
--
-- ── APPLIED (as 20260915075246; checked 2026-10-15, limecore#63 §6) ──────
-- The note below is kept as written at the time.
-- Written 2026-09-14. Production DDL is a per-migration decision by the
-- owner, and this has not been authorised. Nothing depends on it yet: the
-- pacing arithmetic in src/lib/goalPacing.ts is pure and reads no column,
-- and no UI is wired to it.
--
-- ── WHY A COLUMN AND NOT A UI FLAG ───────────────────────────────────────
--
-- A goal is a destination reached at an uneven pace; a habit today is an
-- unbroken cadence with a streak that resets. Composing them naively means a
-- quiet week actively discourages the user at the moment they were still
-- making progress. So goal-linked tracking gets a different mechanic — a
-- cumulative line against an evenly distributed reference, where nothing
-- resets and "behind" is stated as a number of sessions that closes the gap.
--
-- But a strict daily habit — medication reminders are the clear case — SHOULD
-- keep its streak, because there a hard cadence is exactly the point. Two
-- display modes over the same completion data, and which one a habit gets is
-- a property OF THE HABIT, not of the screen it is drawn on. A per-device UI
-- toggle would make the same habit behave differently on a phone and a
-- laptop, which is not a preference, it is a bug.
--
-- ── ADDITIVE, PER `P1` ───────────────────────────────────────────────────
--
-- Nullable with a default, no backfill, no change to `frequency_kind` or
-- `days_of_week`. Every existing row and every shipped client keeps exactly
-- the behaviour it has: unset reads as `strict_streak`, which is what every
-- habit does today. A client that does not know this column writes every
-- other field as before and never clears it.
--
-- Text rather than an enum, for the same reason habit `type` is text: a value
-- a newer client writes must not fail an older server's upsert, and adding a
-- third mode later must not need a type migration in lockstep.
--
-- ── RLS ──────────────────────────────────────────────────────────────────
--
-- Unchanged. `habits` already enforces user_id = auth.uid(); adding a column
-- does not touch its policies (`P2`).

alter table public.habits
  add column if not exists pacing_kind text not null default 'strict_streak';

alter table public.habits
  drop constraint if exists habits_pacing_kind_check;

-- A check rather than an enum: it can be widened with one ALTER, and it still
-- stops a typo becoming a habit that renders as neither mode.
alter table public.habits
  add constraint habits_pacing_kind_check
  check (pacing_kind in ('strict_streak', 'cumulative_to_goal'));

comment on column public.habits.pacing_kind is
  'v1.14. Which mechanic this habit is shown with. `strict_streak` is the '
  'existing streak UI and the default for every row. `cumulative_to_goal` is '
  'goal-linked pacing: a cumulative line against an even reference trajectory, '
  'with no streak, nothing that resets, and no failure state — deliberately, '
  'because a broken streak on an off week discourages continuing toward the '
  'goal itself. Not a per-device preference: the same habit must behave the '
  'same way on every device.';
