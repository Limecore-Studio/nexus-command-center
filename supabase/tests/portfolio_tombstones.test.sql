-- NCC#92 — checks for 20261022_portfolio_tombstones.sql, run against a real
-- Postgres, never production.
--
-- Run (throwaway container):
--   docker run -d --rm --name pttest -e POSTGRES_PASSWORD=x postgres:17
--   docker cp supabase pttest:/work
--   docker exec pttest psql -U postgres -q \
--     -f /work/tests/portfolio_tombstones.fixture.sql \
--     -f /work/migrations/20261022_portfolio_tombstones.sql \
--     -f /work/tests/portfolio_tombstones.test.sql
--   docker rm -f pttest
--
-- One PASS/FAIL line per check, then a summary; the final RAISE makes psql exit
-- non-zero if anything failed.

\set ON_ERROR_STOP 1
set client_min_messages = notice;

create temp table results (name text, ok boolean);

-- The columns, nullable (P1).
insert into results
select 'deleted_at added, nullable: ' || t,
       exists (select 1 from information_schema.columns
                where table_schema = 'public' and table_name = t
                  and column_name = 'deleted_at' and is_nullable = 'YES'
                  and data_type = 'timestamp with time zone')
  from unnest(array['portfolio_holdings', 'stock_sales', 'portfolio_cash_entries']) t;

-- Purge fixtures. old = past the 90-day window, new = inside it.
insert into public.portfolio_holdings (id, deleted_at) values
  ('00000000-0000-0000-0000-000000000001', now() - interval '100 days'), -- old, live lot: kept
  ('00000000-0000-0000-0000-000000000002', now() - interval '100 days'), -- old, dead lot: purged
  ('00000000-0000-0000-0000-000000000003', now() - interval '10 days'),  -- new: kept
  ('00000000-0000-0000-0000-000000000004', null);                        -- live: kept
insert into public.portfolio_lots (id, holding_id, deleted_at) values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000001', null),
  ('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-000000000002', now() - interval '100 days');
insert into public.stock_sales (id, deleted_at) values
  ('00000000-0000-0000-0000-0000000000b1', now() - interval '100 days'),
  ('00000000-0000-0000-0000-0000000000b2', now() - interval '10 days'),
  ('00000000-0000-0000-0000-0000000000b3', null);
insert into public.portfolio_cash_entries (id, deleted_at) values
  ('00000000-0000-0000-0000-0000000000c1', now() - interval '100 days'),
  ('00000000-0000-0000-0000-0000000000c2', now() - interval '10 days'),
  ('00000000-0000-0000-0000-0000000000c3', null);

create temp table purge_run as select * from public.purge_soft_deleted();

insert into results values
  ('purge reports the three new tables',
     (select count(*) from purge_run
       where table_name in ('portfolio_holdings', 'stock_sales', 'portfolio_cash_entries')) = 3),
  ('holdings: old tombstone with a dead lot purged',
     not exists (select 1 from public.portfolio_holdings where id = '00000000-0000-0000-0000-000000000002')),
  ('holdings: old tombstone with a live lot kept (no cascade)',
     exists (select 1 from public.portfolio_holdings where id = '00000000-0000-0000-0000-000000000001')
     and exists (select 1 from public.portfolio_lots where id = '00000000-0000-0000-0000-0000000000a1')),
  ('holdings: recent tombstone and live row kept',
     (select count(*) from public.portfolio_holdings
       where id in ('00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000004')) = 2),
  ('holdings purged count is 1',
     (select purged from purge_run where table_name = 'portfolio_holdings') = 1),
  ('stock_sales: only the old tombstone purged',
     (select array_agg(id::text order by id) from public.stock_sales)
       = array['00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000b3']),
  ('portfolio_cash_entries: only the old tombstone purged',
     (select array_agg(id::text order by id) from public.portfolio_cash_entries)
       = array['00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000c3']),
  ('purge still not executable by API roles',
     not has_function_privilege('authenticated', 'public.purge_soft_deleted(interval)', 'execute')
     and not has_function_privilege('anon', 'public.purge_soft_deleted(interval)', 'execute')),
  ('search_path hardening kept',
     (select proconfig from pg_proc where oid = 'public.purge_soft_deleted(interval)'::regprocedure)
       = array['search_path=pg_catalog, public, pg_temp']);

-- Re-running the migration's guard against the new body must refuse.
do $$
begin
  begin
    if md5(pg_get_functiondef('public.purge_soft_deleted(interval)'::regprocedure))
         <> 'f88915fb18409393e74829ca7d5e4ed4' then
      raise exception 'guard';
    end if;
    insert into results values ('guard refuses a changed body', false);
  exception when raise_exception then
    insert into results values ('guard refuses a changed body', true);
  end;
end $$;

select (case when ok then 'PASS  ' else 'FAIL  ' end) || name as result from results;

do $$
declare failed int := (select count(*) from results where not ok);
begin
  raise notice '% checks, % failed', (select count(*) from results), failed;
  if failed > 0 then raise exception 'portfolio_tombstones: % check(s) failed', failed; end if;
end $$;
