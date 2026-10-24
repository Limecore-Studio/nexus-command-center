-- NCC#202 — the production "before" state for 20261023_recurring_rules.sql,
-- for a throwaway Postgres. Load order (each file once):
--   tests/portfolio_tombstones.fixture.sql        (the base stubs)
--   migrations/20261022_portfolio_tombstones.sql  (applied in production)
--   tests/recurring_rules.fixture.sql             (this file)
--   migrations/20261023_recurring_rules.sql
--   tests/recurring_rules.test.sql
-- The 1023 migration's md5 guard passing proves the purge body here is
-- production's.

\set ON_ERROR_STOP 1
set client_min_messages = warning;

-- Columns the new migration touches or the generic triggers read.
alter table public.transactions   add column if not exists updated_at timestamptz;

-- The live trigger functions (read 2026-10-22), verbatim bodies.
create or replace function public.set_updated_at()
 returns trigger
 language plpgsql
 set search_path to ''
as $function$
declare
  old_deleted text;
  new_deleted text;
begin
  -- 1. Clamp. NULL means "the client did not say": stamp it now, as before.
  if new.updated_at is null or new.updated_at > now() then
    new.updated_at := now();
  end if;

  if tg_op = 'INSERT' then
    return new;
  end if;

  old_deleted := to_jsonb(old) ->> 'deleted_at';
  new_deleted := to_jsonb(new) ->> 'deleted_at';

  -- 2. Delete wins: a tombstone always lands, and is at least as new as the
  --    row it replaces.
  if old_deleted is null and new_deleted is not null then
    new.updated_at := greatest(new.updated_at, least(old.updated_at, now()));
    return new;
  end if;

  -- 3. Everything else, a revival included, is last-writer-wins. A stored
  --    stamp from the future counts as now, so it cannot lock the row.
  if old.updated_at is not null and new.updated_at < least(old.updated_at, now()) then
    return old;
  end if;

  return new;
end;
$function$;

create or replace function public.skip_noop_update()
 returns trigger
 language plpgsql
 set search_path to ''
as $function$
begin
  if (to_jsonb(new) - 'updated_at') = (to_jsonb(old) - 'updated_at') then
    return null;
  end if;
  return new;
end;
$function$;

grant usage on schema public to authenticated;
