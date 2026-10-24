-- NCC#204 — checks for 20261024_bond_custom_holdings.sql, run against a real
-- Postgres, never production.
--
-- Run (throwaway container):
--   docker run -d --rm --name bctest -e POSTGRES_PASSWORD=x postgres:17
--   docker cp supabase bctest:/work
--   docker exec bctest psql -U postgres -q \
--     -f /work/tests/portfolio_tombstones.fixture.sql \
--     -f /work/migrations/20261022_portfolio_tombstones.sql \
--     -f /work/tests/recurring_rules.fixture.sql \
--     -f /work/migrations/20261023_recurring_rules.sql \
--     -f /work/tests/bond_custom_holdings.fixture.sql \
--     -f /work/migrations/20261024_bond_custom_holdings.sql \
--     -f /work/tests/bond_custom_holdings.test.sql
--   docker rm -f bctest
--
-- One PASS/FAIL line per check, then a summary; the final RAISE makes psql exit
-- non-zero if anything failed.

\set ON_ERROR_STOP 1
set client_min_messages = notice;

create temp table results (name text, ok boolean);

insert into results values
  ('existing holding untouched',
     (select asset_type = 'etf' and manual_price is null and bond_terms is null
        from public.portfolio_holdings where id = '20000000-0000-0000-0000-000000000001')),
  ('new columns nullable',
     (select count(*) = 4 from information_schema.columns
       where table_schema = 'public' and table_name = 'portfolio_holdings' and is_nullable = 'YES'
         and column_name in ('manual_price', 'manual_price_currency', 'manual_price_at', 'bond_terms')));

insert into public.portfolio_holdings (id, asset_type, ticker, quantity, bond_terms)
values ('20000000-0000-0000-0000-000000000002', 'bond', 'DE-2030', 10,
        '{"faceValue":100,"currency":"EUR","couponRate":4,"couponFrequency":1,"maturity":"2030-06-15"}');
insert into public.portfolio_holdings (id, asset_type, ticker, quantity, manual_price, manual_price_currency, manual_price_at)
values ('20000000-0000-0000-0000-000000000003', 'custom', 'WATCH', 1, 1500, 'EUR', now());
insert into public.portfolio_holdings (id, asset_type, ticker, quantity)
values ('20000000-0000-0000-0000-000000000004', 'stock', 'AAPL', 1);
insert into results values
  ('bond, custom and the old types are accepted',
     (select count(*) = 4 from public.portfolio_holdings));

insert into auth.users values ('00000000-0000-0000-0000-00000000000c') on conflict do nothing;
insert into public.recurring_rules (id, user_id, kind, template, every, unit, start_date)
values ('30000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000c',
        'coupon', '{"holdingId":"20000000-0000-0000-0000-000000000002"}', 12, 'month', '2026-06-15');
insert into results values
  ('a coupon rule is accepted', exists (select 1 from public.recurring_rules where kind = 'coupon'));

do $$
begin
  begin
    insert into public.portfolio_holdings (id, asset_type, ticker) values (gen_random_uuid(), 'weird', 'X');
    insert into results values ('unknown asset type refused', false);
  exception when check_violation then
    insert into results values ('unknown asset type refused', true);
  end;
  begin
    insert into public.portfolio_holdings (id, asset_type, ticker, manual_price) values (gen_random_uuid(), 'custom', 'X', -1);
    insert into results values ('negative manual price refused', false);
  exception when check_violation then
    insert into results values ('negative manual price refused', true);
  end;
  begin
    insert into public.portfolio_holdings (id, asset_type, ticker, bond_terms) values (gen_random_uuid(), 'bond', 'X', '[1,2]');
    insert into results values ('bond_terms must be an object', false);
  exception when check_violation then
    insert into results values ('bond_terms must be an object', true);
  end;
  begin
    insert into public.recurring_rules (id, user_id, kind, template, every, unit, start_date)
    values (gen_random_uuid(), '00000000-0000-0000-0000-00000000000c', 'weird', '{}', 1, 'day', '2026-10-01');
    insert into results values ('unknown rule kind still refused', false);
  exception when check_violation then
    insert into results values ('unknown rule kind still refused', true);
  end;
end $$;

select (case when ok then 'PASS  ' else 'FAIL  ' end) || name as result from results;

do $$
declare failed int := (select count(*) from results where not ok);
begin
  raise notice '% checks, % failed', (select count(*) from results), failed;
  if failed > 0 then raise exception 'bond_custom_holdings: % check(s) failed', failed; end if;
end $$;
