-- v1.19 — NCC#202: recurring rules (income/expense, deposits to portfolio
-- cash, recurring buys).
--
-- A rule lives in `recurring_rules`. Each device materialises the rule's due
-- occurrences into ordinary rows (transactions, portfolio_lots,
-- portfolio_cash_entries) with DETERMINISTIC ids, uuidv5(rule:date:part), so
-- two devices materialising the same occurrence produce the same row. The
-- generated rows carry `recurring_rule_id`.
--
-- P1: one new table and three nullable columns; nothing renamed or dropped.
-- Old NCC versions never send `recurring_rule_id`, so their upserts leave it
-- as it is; they show generated rows as ordinary rows.
-- P2: RLS and the policy are in this same migration.
--
-- NOT YET APPLIED. Owner applies (P1 sign-off).

-- ── Guard: only extend the purge function we have actually read ─────────────
-- Live body after 20261022_portfolio_tombstones.sql (read 2026-10-22).
do $$
begin
  if md5(pg_get_functiondef('public.purge_soft_deleted(interval)'::regprocedure))
       <> '160b414d4838bd7abc0a249f461308b4' then
    raise exception 'NCC#202: purge_soft_deleted() changed since 2026-10-22; re-read it and update this migration';
  end if;
end $$;

-- ── The table ────────────────────────────────────────────────────────────────
create table if not exists public.recurring_rules (
  id                     uuid        primary key,
  user_id                uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  kind                   text        not null check (kind in ('transaction', 'cash_deposit', 'buy')),
  -- What one occurrence writes; shape per kind, validated by the client.
  template               jsonb       not null check (jsonb_typeof(template) = 'object' and pg_column_size(template) <= 4096),
  every                  integer     not null check (every between 1 and 366),
  unit                   text        not null check (unit in ('day', 'week', 'month')),
  -- Day of month a monthly rule falls on (clamped to the month's last day).
  anchor_day             integer     check (anchor_day between 1 and 31),
  start_date             date        not null,
  end_date               date        check (end_date is null or end_date >= start_date),
  last_materialized_date date,
  paused_at              timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  deleted_at             timestamptz
);

create index if not exists recurring_rules_user_idx on public.recurring_rules (user_id);

alter table public.recurring_rules enable row level security;

create policy "Users manage own rules"
  on public.recurring_rules for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- NCC deletes by tombstone; account erasure cascades from auth.users. No
-- client role needs DELETE or anything beyond read/insert/update.
revoke all on table public.recurring_rules from anon, authenticated;
grant select, insert, update on table public.recurring_rules to authenticated;

-- Last-writer-wins with "delete wins", as every other synced NCC table.
create trigger recurring_rules_updated_at
  before insert or update on public.recurring_rules
  for each row execute function public.set_updated_at();

-- last_materialized_date never moves backwards: a device that materialised
-- less (offline, behind) must not make another one generate the same dates
-- again. Runs after set_updated_at's LWW decision ("zz" sorts last among
-- BEFORE triggers, "yy" just before zz_skip_noop_update).
create or replace function private.recurring_rules_keep_progress()
returns trigger
language plpgsql
set search_path to ''
as $$
begin
  if old.last_materialized_date is not null
     and (new.last_materialized_date is null or new.last_materialized_date < old.last_materialized_date) then
    new.last_materialized_date := old.last_materialized_date;
  end if;
  return new;
end;
$$;
revoke all on function private.recurring_rules_keep_progress() from public, anon, authenticated;

create trigger yy_recurring_rules_keep_progress
  before update on public.recurring_rules
  for each row execute function private.recurring_rules_keep_progress();

create trigger zz_skip_noop_update
  before update on public.recurring_rules
  for each row execute function public.skip_noop_update();

-- ── Generated rows point back at their rule ─────────────────────────────────
-- No foreign key: a rule is tombstoned, never deleted, while its generated
-- rows live on as ordinary rows ("keep past entries").
alter table public.transactions           add column if not exists recurring_rule_id uuid;
alter table public.portfolio_lots         add column if not exists recurring_rule_id uuid;
alter table public.portfolio_cash_entries add column if not exists recurring_rule_id uuid;

-- ── 90-day purge of rule tombstones ──────────────────────────────────────────
-- Everything but the block marked NCC#202 is the live body as read on
-- 2026-10-22, unchanged.
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

revoke execute on function public.purge_soft_deleted(interval) from public, anon, authenticated;
