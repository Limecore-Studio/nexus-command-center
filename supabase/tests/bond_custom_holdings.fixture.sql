-- NCC#204 — the production "before" state for 20261024_bond_custom_holdings.sql,
-- for a throwaway Postgres. Load order (each file once):
--   tests/portfolio_tombstones.fixture.sql
--   migrations/20261022_portfolio_tombstones.sql
--   tests/recurring_rules.fixture.sql
--   migrations/20261023_recurring_rules.sql
--   tests/bond_custom_holdings.fixture.sql          (this file)
--   migrations/20261024_bond_custom_holdings.sql
--   tests/bond_custom_holdings.test.sql
-- portfolio_holdings gains the columns and the asset_type CHECK it has in
-- production (read 2026-10-22), under the same constraint name.

\set ON_ERROR_STOP 1
set client_min_messages = warning;

alter table public.portfolio_holdings
  add column asset_type text not null default 'stock',
  add column ticker     text not null default 'X',
  add column quantity   numeric not null default 0 check (quantity >= 0);
alter table public.portfolio_holdings add constraint portfolio_holdings_asset_type_check
  check (asset_type = any (array['stock'::text, 'crypto'::text, 'etf'::text]));

insert into public.portfolio_holdings (id, asset_type, ticker, quantity)
values ('20000000-0000-0000-0000-000000000001', 'etf', 'VT', 3);
