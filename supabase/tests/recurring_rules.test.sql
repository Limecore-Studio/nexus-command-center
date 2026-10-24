-- NCC#202 — checks for 20261023_recurring_rules.sql, run against a real
-- Postgres, never production.
--
-- Run (throwaway container):
--   docker run -d --rm --name rrtest -e POSTGRES_PASSWORD=x postgres:17
--   docker cp supabase rrtest:/work
--   docker exec rrtest psql -U postgres -q \
--     -f /work/tests/portfolio_tombstones.fixture.sql \
--     -f /work/migrations/20261022_portfolio_tombstones.sql \
--     -f /work/tests/recurring_rules.fixture.sql \
--     -f /work/migrations/20261023_recurring_rules.sql \
--     -f /work/tests/recurring_rules.test.sql
--   docker rm -f rrtest
--
-- One PASS/FAIL line per check, then a summary; the final RAISE makes psql exit
-- non-zero if anything failed.

\set ON_ERROR_STOP 1
set client_min_messages = notice;

create temp table results (name text, ok boolean);
grant all on results to authenticated;

insert into auth.users values
  ('00000000-0000-0000-0000-00000000000a'), ('00000000-0000-0000-0000-00000000000b');

-- ── Schema ───────────────────────────────────────────────────────────────────
insert into results values
  ('RLS enabled', (select relrowsecurity from pg_class where oid = 'public.recurring_rules'::regclass)),
  ('anon has no access',
     not has_table_privilege('anon', 'public.recurring_rules', 'select')
     and not has_table_privilege('anon', 'public.recurring_rules', 'insert')),
  ('authenticated: select/insert/update, no delete/truncate',
     has_table_privilege('authenticated', 'public.recurring_rules', 'select')
     and has_table_privilege('authenticated', 'public.recurring_rules', 'insert')
     and has_table_privilege('authenticated', 'public.recurring_rules', 'update')
     and not has_table_privilege('authenticated', 'public.recurring_rules', 'delete')
     and not has_table_privilege('authenticated', 'public.recurring_rules', 'truncate')),
  ('recurring_rule_id added, nullable, on 3 tables',
     (select count(*) from information_schema.columns
       where table_schema = 'public' and column_name = 'recurring_rule_id' and is_nullable = 'YES'
         and table_name in ('transactions', 'portfolio_lots', 'portfolio_cash_entries')) = 3);

-- ── As user A ────────────────────────────────────────────────────────────────
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';

insert into public.recurring_rules (id, kind, template, every, unit, anchor_day, start_date, last_materialized_date, updated_at)
values ('10000000-0000-0000-0000-000000000001', 'transaction', '{"type":"expense","amount":5}', 1, 'month', 31,
        '2026-01-31', '2026-09-30', '2026-10-01T00:00:00Z');

insert into results values
  ('insert own: user_id defaults to auth.uid()',
     (select user_id from public.recurring_rules where id = '10000000-0000-0000-0000-000000000001')
       = '00000000-0000-0000-0000-00000000000a');

-- Progress never moves backwards, even from a newer edit.
update public.recurring_rules set last_materialized_date = '2026-08-31', template = '{"type":"expense","amount":6}',
       updated_at = '2026-10-02T00:00:00Z'
 where id = '10000000-0000-0000-0000-000000000001';
insert into results values
  ('a newer edit lands but progress stays at the furthest date',
     (select last_materialized_date = '2026-09-30' and (template ->> 'amount') = '6'
        from public.recurring_rules where id = '10000000-0000-0000-0000-000000000001'));

-- LWW: an older edit is declined.
update public.recurring_rules set every = 2, updated_at = '2026-09-01T00:00:00Z'
 where id = '10000000-0000-0000-0000-000000000001';
insert into results values
  ('an older edit is declined (last writer wins)',
     (select every = 1 from public.recurring_rules where id = '10000000-0000-0000-0000-000000000001'));

-- Delete wins, whatever its stamp.
update public.recurring_rules set deleted_at = now(), updated_at = '2020-01-01T00:00:00Z'
 where id = '10000000-0000-0000-0000-000000000001';
insert into results values
  ('a tombstone lands even with an old stamp',
     (select deleted_at is not null from public.recurring_rules where id = '10000000-0000-0000-0000-000000000001'));

-- A rule can't be filed under someone else, nor deleted outright.
do $$
begin
  begin
    insert into public.recurring_rules (id, user_id, kind, template, every, unit, start_date)
    values ('10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-00000000000b',
            'transaction', '{}', 1, 'day', '2026-10-01');
    insert into results values ('insert for another user refused', false);
  exception when insufficient_privilege then
    insert into results values ('insert for another user refused', true);
  end;
  begin
    delete from public.recurring_rules where id = '10000000-0000-0000-0000-000000000001';
    insert into results values ('delete refused', false);
  exception when insufficient_privilege then
    insert into results values ('delete refused', true);
  end;
  begin
    insert into public.recurring_rules (id, kind, template, every, unit, start_date)
    values ('10000000-0000-0000-0000-000000000003', 'weird', '{}', 1, 'day', '2026-10-01');
    insert into results values ('unknown kind refused', false);
  exception when check_violation then
    insert into results values ('unknown kind refused', true);
  end;
end $$;

-- ── As user B: A's rule is invisible and untouchable ────────────────────────
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000b';
update public.recurring_rules set every = 9 where true;
insert into results values
  ('another user sees no rule', (select count(*) = 0 from public.recurring_rules));
reset role;
insert into results values
  ('another user could not update it',
     (select every = 1 from public.recurring_rules where id = '10000000-0000-0000-0000-000000000001'));

-- ── Purge ────────────────────────────────────────────────────────────────────
update public.recurring_rules set deleted_at = now() - interval '100 days'
 where id = '10000000-0000-0000-0000-000000000001';
create temp table purge_run as select * from public.purge_soft_deleted();
insert into results values
  ('purge removes an old rule tombstone',
     not exists (select 1 from public.recurring_rules)
     and (select purged from purge_run where table_name = 'recurring_rules') = 1),
  ('purge still not executable by API roles',
     not has_function_privilege('authenticated', 'public.purge_soft_deleted(interval)', 'execute'));

select (case when ok then 'PASS  ' else 'FAIL  ' end) || name as result from results;

do $$
declare failed int := (select count(*) from results where not ok);
begin
  raise notice '% checks, % failed', (select count(*) from results), failed;
  if failed > 0 then raise exception 'recurring_rules: % check(s) failed', failed; end if;
end $$;
