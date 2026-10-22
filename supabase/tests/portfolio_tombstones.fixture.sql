-- limecore#16 — the production "before" state 20260926_client_errors.sql is
-- written against, for a throwaway Postgres. Supabase's auth schema and API
-- roles are stubbed; every table purge_soft_deleted() touches exists with the
-- columns it reads. purge_soft_deleted() is created from the migration's own
-- copy with the client_errors block removed, which must reproduce
-- production's body exactly: the migration's md5 guard fails otherwise, so a
-- passing run is itself the proof that this fixture matches production.
--
-- Load order: this file, then the migration, then client_errors.test.sql.

\set ON_ERROR_STOP 1
set client_min_messages = warning;

create role anon nologin;
create role authenticated nologin;
create schema auth;
create schema private;
create table auth.users (id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
grant usage on schema auth, public to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;
grant usage on schema private to authenticated;

-- Every table the purge function reads, with the columns it reads.
create table public.subjects (id uuid primary key default gen_random_uuid(), deleted_at timestamptz);
do $$
declare t text;
begin
  foreach t in array array['grades','study_sessions','readings','assignments','exams','study_actions',
                           'timetable_entries','planned_sessions'] loop
    execute format('create table public.%I (id uuid primary key default gen_random_uuid(), subject_id uuid, deleted_at timestamptz)', t);
  end loop;
  foreach t in array array['budget_categories','manual_assets','goals','tasks',
                           'watchlist_items','workout_sessions'] loop
    execute format('create table public.%I (id uuid primary key default gen_random_uuid(), deleted_at timestamptz)', t);
  end loop;
end $$;
-- The three NCC#92 tables, before: no deleted_at. portfolio_lots cascades
-- from portfolio_holdings, as in production.
create table public.portfolio_holdings (id uuid primary key default gen_random_uuid(), updated_at timestamptz);
create table public.portfolio_lots (id uuid primary key default gen_random_uuid(),
  holding_id uuid references public.portfolio_holdings (id) on delete cascade, deleted_at timestamptz);
create table public.stock_sales (id uuid primary key default gen_random_uuid(), holding_id uuid);
create table public.portfolio_cash_entries (id uuid primary key default gen_random_uuid());
create table public.client_errors (id uuid primary key default gen_random_uuid(), created_at timestamptz not null default now());
create table public.transactions (id uuid primary key default gen_random_uuid(), category_id uuid,
  account_id uuid, destination_account_id uuid, deleted_at timestamptz);

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
