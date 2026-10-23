-- v1.19 — NCC#92: tombstones for the portfolio tables.
--
-- portfolio_holdings, stock_sales and portfolio_cash_entries were hard-
-- DELETEd by NCC. A second device never learned of the delete, so the row
-- lived on there (and its next edit re-created it upstream). portfolio_lots
-- already has a tombstone. NCC (from v1.19) writes `deleted_at` instead and
-- pulls tombstones like every other soft-delete table (NCC#56 part 2).
--
-- P1: three nullable columns and one rewritten function; nothing renamed or
-- dropped. Old NCC versions never send `deleted_at`, so their upserts cannot
-- un-delete a row, and their hard deletes still work. They also do not filter
-- tombstones on pull, so an un-updated device shows a row deleted elsewhere
-- until it updates (today it keeps such a row anyway, forever).
-- P2: no new table; the existing RLS policies cover the new columns.
--
-- portfolio_holdings already runs public.set_updated_at(), whose "delete
-- wins" rule reads `deleted_at` generically, so a tombstone always lands
-- there. stock_sales and portfolio_cash_entries have no updated_at and no
-- LWW trigger: they are append-only ledgers whose upserts never send
-- `deleted_at`, so nothing un-deletes them either.
--
-- Tested against Postgres 17: supabase/tests/portfolio_tombstones.test.sql.
-- APPLIED to production 2026-10-22 (owner-approved in session) as
-- `v119_portfolio_tombstones`, version 20261022111346. Before this, a v1.19
-- delete on these tables fell back to the hard delete.

-- ── Guard: only extend the purge function we have actually read ─────────────
-- Live body read 2026-10-22 (20260926_client_errors.sql plus the later
-- search_path hardening, limecore#63). Anything else stops the migration.
do $$
begin
  if md5(pg_get_functiondef('public.purge_soft_deleted(interval)'::regprocedure))
       <> 'f88915fb18409393e74829ca7d5e4ed4' then
    raise exception 'NCC#92: purge_soft_deleted() changed since 2026-10-22; re-read it and update this migration';
  end if;
end $$;

-- ── The columns ──────────────────────────────────────────────────────────────
alter table public.portfolio_holdings     add column if not exists deleted_at timestamptz;
alter table public.stock_sales            add column if not exists deleted_at timestamptz;
alter table public.portfolio_cash_entries add column if not exists deleted_at timestamptz;

-- ── 90-day purge of the new tombstones ───────────────────────────────────────
-- Everything but the three blocks marked NCC#92 is the live body as read on
-- 2026-10-22, unchanged. portfolio_holdings is a parent: portfolio_lots is
-- ON DELETE CASCADE from it, so a holding with a live lot is skipped (the
-- same guard as subjects and budget_categories).
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

-- create or replace keeps the existing grants; restated so a fresh
-- environment matches production.
revoke execute on function public.purge_soft_deleted(interval) from public, anon, authenticated;
