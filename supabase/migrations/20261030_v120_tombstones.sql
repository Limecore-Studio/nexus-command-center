-- v1.20 — NCC#92, the rest: tombstones for habits, habit completions, work
-- logs and braindump.
-- APPLIED to production 2026-10-30 with the owner's OK (history version 20261030062556).
--
-- NCC hard-DELETEd these, so a second device never learned of a delete and
-- its next edit re-created the row upstream (the defect of NCC#56). v1.19 did
-- the portfolio tables (20261022_portfolio_tombstones.sql); this is the same
-- shape for the last four. NCC (from v1.20) writes `deleted_at` instead and
-- pulls the tombstones.
--
-- braindump_entries already has `deleted_at` (NCC never wrote it); it only
-- needs its purge line.
--
-- One-row-per-day tables. habit_completions is UNIQUE (habit_id, date) and
-- work_quality_logs UNIQUE (user_id, log_date): a day re-marked after it was
-- cleared is the same row, and it must come back. NCC from v1.20 sends
-- `deleted_at: null` on those writes. Older builds do not know the column, so
-- the trigger below also revives a tombstoned day row whose content a write
-- changes. A re-sent identical row (a queue retry) does not revive it.
--
-- P1: three nullable columns, one new trigger function, one rewritten purge
-- function; nothing renamed or dropped. Older NCC builds do not filter these
-- tombstones on pull, so a row deleted on a v1.20 device shows on an un-updated
-- one until it updates. Today such a row stays there forever, as with the
-- portfolio tables in v1.19. StudyDesk and LimeLog read none of these tables.
-- P2: no new table; the existing RLS policies cover the new columns.
--
-- Deletes: habits and braindump use public.set_updated_at() ("delete wins") or
-- stamp now() (habits), and NCC's upserts of them never send `deleted_at`, so
-- an edit cannot undo a delete. work_quality_logs runs set_updated_at() too,
-- so a revival there is last-writer-wins on the edit stamp.
--
-- Tested against the full production schema on a local stack:
-- supabase/tests/v120_tombstones.test.sql.

-- ── Guard: only extend the purge function we have actually read ─────────────
-- Live body read 2026-10-29 (v1.19: portfolio tombstones and recurring rules).
do $$
begin
  if md5(pg_get_functiondef('public.purge_soft_deleted(interval)'::regprocedure))
       <> '040789ff4938a1272dd5c2863d9a3a0f' then
    raise exception 'NCC#92: purge_soft_deleted() changed since 2026-10-29; re-read it and update this migration';
  end if;
end $$;

-- ── The columns ──────────────────────────────────────────────────────────────
alter table public.habits            add column if not exists deleted_at timestamptz;
alter table public.habit_completions add column if not exists deleted_at timestamptz;
alter table public.work_quality_logs add column if not exists deleted_at timestamptz;

-- ── Re-marking a cleared day brings it back ──────────────────────────────────
create or replace function public.revive_rewritten_tombstone()
returns trigger
language plpgsql
set search_path to ''
as $$
begin
  -- A tombstoned row whose content this write changes, while the write itself
  -- leaves `deleted_at` alone: an older build re-marking a cleared day.
  if old.deleted_at is not null
     and new.deleted_at is not distinct from old.deleted_at
     and (to_jsonb(new) - 'deleted_at' - 'updated_at') <> (to_jsonb(old) - 'deleted_at' - 'updated_at') then
    new.deleted_at := null;
  end if;
  return new;
end;
$$;
comment on function public.revive_rewritten_tombstone() is
  'NCC#92: BEFORE UPDATE on one-row-per-day tables. A write that changes a tombstoned row''s content revives it. Named to run before set_updated_at() and zz_skip_noop_update.';

drop trigger if exists revive_rewritten_tombstone on public.habit_completions;
create trigger revive_rewritten_tombstone
  before update on public.habit_completions
  for each row execute function public.revive_rewritten_tombstone();

drop trigger if exists revive_rewritten_tombstone on public.work_quality_logs;
create trigger revive_rewritten_tombstone
  before update on public.work_quality_logs
  for each row execute function public.revive_rewritten_tombstone();

-- ── 90-day purge of the new tombstones ───────────────────────────────────────
-- Everything but the blocks marked "NCC#92 (v1.20)" is the live body as read
-- on 2026-10-29, unchanged.
create or replace function public.purge_soft_deleted(retain interval default '90 days'::interval)
 returns table(table_name text, purged bigint)
 language plpgsql
 security definer
 set search_path to 'pg_catalog', 'public', 'pg_temp'
as $function$
declare
  cutoff timestamptz := now() - retain;
  n bigint;
begin
  delete from grades          where deleted_at is not null and deleted_at < cutoff;
  get diagnostics n = row_count; table_name := 'grades'; purged := n; return next;

  delete from study_sessions  where deleted_at is not null and deleted_at < cutoff;
  get diagnostics n = row_count; table_name := 'study_sessions'; purged := n; return next;

  delete from readings        where deleted_at is not null and deleted_at < cutoff;
  get diagnostics n = row_count; table_name := 'readings'; purged := n; return next;

  delete from transactions    where deleted_at is not null and deleted_at < cutoff;
  get diagnostics n = row_count; table_name := 'transactions'; purged := n; return next;

  -- CHANGED: guard extended from 3 children to all 8. `assignments` and
  -- `exams` are the load-bearing additions — they are ON DELETE CASCADE, so
  -- omitting them is what made this function destructive rather than merely
  -- incomplete.
  delete from subjects s
   where s.deleted_at is not null and s.deleted_at < cutoff
     and not exists (select 1 from grades g            where g.subject_id  = s.id and g.deleted_at  is null)
     and not exists (select 1 from study_sessions ss   where ss.subject_id = s.id and ss.deleted_at is null)
     and not exists (select 1 from readings r          where r.subject_id  = s.id and r.deleted_at  is null)
     and not exists (select 1 from assignments a       where a.subject_id  = s.id and a.deleted_at  is null)
     and not exists (select 1 from exams e             where e.subject_id  = s.id and e.deleted_at  is null)
     and not exists (select 1 from study_actions sa    where sa.subject_id = s.id and sa.deleted_at is null)
     and not exists (select 1 from timetable_entries t where t.subject_id  = s.id and t.deleted_at  is null)
     and not exists (select 1 from planned_sessions p  where p.subject_id  = s.id and p.deleted_at  is null);
  get diagnostics n = row_count; table_name := 'subjects'; purged := n; return next;

  delete from budget_categories bc
   where bc.deleted_at is not null and bc.deleted_at < cutoff
     and not exists (select 1 from transactions t where t.category_id = bc.id and t.deleted_at is null);
  get diagnostics n = row_count; table_name := 'budget_categories'; purged := n; return next;

  delete from manual_assets ma
   where ma.deleted_at is not null and ma.deleted_at < cutoff
     and not exists (select 1 from transactions t
                      where (t.account_id = ma.id or t.destination_account_id = ma.id)
                        and t.deleted_at is null);
  get diagnostics n = row_count; table_name := 'manual_assets'; purged := n; return next;

  delete from goals            where deleted_at is not null and deleted_at < cutoff;
  get diagnostics n = row_count; table_name := 'goals'; purged := n; return next;

  delete from portfolio_lots   where deleted_at is not null and deleted_at < cutoff;
  get diagnostics n = row_count; table_name := 'portfolio_lots'; purged := n; return next;

  -- NCC#92: a parent of portfolio_lots (ON DELETE CASCADE): skip any holding
  -- that still has a live lot.
  delete from portfolio_holdings ph
   where ph.deleted_at is not null and ph.deleted_at < cutoff
     and not exists (select 1 from portfolio_lots l where l.holding_id = ph.id and l.deleted_at is null);
  get diagnostics n = row_count; table_name := 'portfolio_holdings'; purged := n; return next;

  -- NCC#92
  delete from stock_sales      where deleted_at is not null and deleted_at < cutoff;
  get diagnostics n = row_count; table_name := 'stock_sales'; purged := n; return next;

  -- NCC#92
  delete from portfolio_cash_entries where deleted_at is not null and deleted_at < cutoff;
  get diagnostics n = row_count; table_name := 'portfolio_cash_entries'; purged := n; return next;

  -- NCC#202: generated rows have no foreign key to their rule, so a rule
  -- tombstone has no children to guard.
  delete from recurring_rules  where deleted_at is not null and deleted_at < cutoff;
  get diagnostics n = row_count; table_name := 'recurring_rules'; purged := n; return next;

  -- NCC#92 (v1.20)
  delete from habit_completions where deleted_at is not null and deleted_at < cutoff;
  get diagnostics n = row_count; table_name := 'habit_completions'; purged := n; return next;

  -- NCC#92 (v1.20): a parent of habit_completions (ON DELETE CASCADE). A
  -- deleted habit's days go with it: they mean nothing without the habit, and
  -- NCC tombstones them alongside it.
  delete from habits           where deleted_at is not null and deleted_at < cutoff;
  get diagnostics n = row_count; table_name := 'habits'; purged := n; return next;

  -- NCC#92 (v1.20)
  delete from work_quality_logs where deleted_at is not null and deleted_at < cutoff;
  get diagnostics n = row_count; table_name := 'work_quality_logs'; purged := n; return next;

  -- NCC#92 (v1.20): the column existed, the purge line did not.
  delete from braindump_entries where deleted_at is not null and deleted_at < cutoff;
  get diagnostics n = row_count; table_name := 'braindump_entries'; purged := n; return next;

  delete from tasks            where deleted_at is not null and deleted_at < cutoff;
  get diagnostics n = row_count; table_name := 'tasks'; purged := n; return next;

  delete from watchlist_items  where deleted_at is not null and deleted_at < cutoff;
  get diagnostics n = row_count; table_name := 'watchlist_items'; purged := n; return next;

  delete from workout_sessions where deleted_at is not null and deleted_at < cutoff;
  get diagnostics n = row_count; table_name := 'workout_sessions'; purged := n; return next;

  -- limecore#16: error reports are kept for the retention window, then go.
  -- Not a soft delete: a report is removed by age alone.
  delete from client_errors    where created_at < cutoff;
  get diagnostics n = row_count; table_name := 'client_errors'; purged := n; return next;
end;
$function$;
