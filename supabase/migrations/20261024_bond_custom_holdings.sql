-- v1.19 — NCC#204: bond and custom-priced holdings.
--
-- Two new holding types, priced without any external API:
--   custom — a price the user enters (manual_price, its currency and when it
--            was set);
--   bond   — hold-to-maturity book value plus accrued interest, from the
--            terms in bond_terms; a manual_price, when set, overrides it.
-- A bond's coupons and its redemption at maturity are written by the
-- recurring engine (NCC#202) through a rule of the new kind 'coupon'.
--
-- P1: two widened CHECKs and four nullable columns; nothing renamed or
-- dropped, no row rewritten. Old NCC versions never send the new columns, so
-- their upserts leave them as they are. An old version that pulls a bond or
-- custom holding has no price for it and shows it unpriced (it does not
-- treat it as anything else it could value).
-- P2: no new table; the existing RLS policies cover the new columns.
--
-- NOT YET APPLIED. Owner applies (P1 sign-off).

-- ── Holding types ────────────────────────────────────────────────────────────
alter table public.portfolio_holdings drop constraint if exists portfolio_holdings_asset_type_check;
alter table public.portfolio_holdings add constraint portfolio_holdings_asset_type_check
  check (asset_type = any (array['stock', 'crypto', 'etf', 'bond', 'custom']));

alter table public.portfolio_holdings
  add column if not exists manual_price          numeric check (manual_price is null or manual_price >= 0),
  add column if not exists manual_price_currency text    check (manual_price_currency is null or char_length(manual_price_currency) between 3 and 8),
  add column if not exists manual_price_at       timestamptz,
  -- { faceValue, currency, couponRate (% p.a.), couponFrequency (0|1|2|4),
  --   maturity (YYYY-MM-DD), isin? }. Validated by the client.
  add column if not exists bond_terms            jsonb   check (bond_terms is null or (jsonb_typeof(bond_terms) = 'object' and pg_column_size(bond_terms) <= 1024));

-- ── Coupon rules ─────────────────────────────────────────────────────────────
alter table public.recurring_rules drop constraint if exists recurring_rules_kind_check;
alter table public.recurring_rules add constraint recurring_rules_kind_check
  check (kind = any (array['transaction', 'cash_deposit', 'buy', 'coupon']));
