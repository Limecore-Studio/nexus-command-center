-- v1.20 — NCC#203: staking yield as a recurring rule kind.
-- APPLIED to production 2026-10-30 with the owner's OK (history version 20261030062610).
-- It must be live before an NCC with yield rules ships. Until then the server refuses a yield
-- rule's push (23514), which NCC treats as permanent and drops.
--
-- A `yield` rule accrues a holding's staking rewards from its APY: every day,
-- the units held times the daily rate, at cost 0, into one lot per calendar
-- month (src/lib/recurringMaterialize.ts writeYield). Its template is
--   { holdingId, apyPct, currency }
-- and deliberately has no `amount` or `quantity`: an NCC 1.19 device reads an
-- unknown kind as a buy, and without either it waits for one forever instead
-- of buying (it renders it as "Buy of X · 0"). `currency` is there so that
-- rendering has a valid currency to format.
--
-- P1: widens one CHECK constraint; no column changes. P2: the existing RLS on
-- recurring_rules covers it.

alter table public.recurring_rules drop constraint if exists recurring_rules_kind_check;
alter table public.recurring_rules add constraint recurring_rules_kind_check
  check (kind = any (array['transaction'::text, 'cash_deposit'::text, 'buy'::text, 'coupon'::text, 'yield'::text]));
