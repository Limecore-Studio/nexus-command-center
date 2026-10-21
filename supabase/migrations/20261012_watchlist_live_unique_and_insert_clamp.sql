-- v1.18.1 (NCC#156) — two server constraints that silently dropped rows.
--
-- OWNER APPLIES. Both parts are idempotent. Checked against production
-- (read-only) on 2026-10-12: constraint watchlist_items_unique_per_user is
-- UNIQUE (user_id, ticker, asset_type), and the five triggers below are
-- BEFORE UPDATE only.
--
-- ── 1. A re-added watchlist ticker never synced ─────────────────────────────
-- Removing a ticker is a soft delete (deleted_at set, row kept), and adding it
-- again makes a new row with a new id. The full UNIQUE constraint still
-- counts the tombstone, so that insert failed with 23505, which the client
-- treats as permanent and drops: the ticker stayed on this device only. The
-- rule that matters is one LIVE row per ticker, so the uniqueness moves to a
-- partial index over live rows. No client upserts on this key (onConflict),
-- so nothing depends on the constraint itself.
create unique index if not exists watchlist_items_live_uidx
  on public.watchlist_items (user_id, ticker, asset_type)
  where deleted_at is null;

alter table public.watchlist_items
  drop constraint if exists watchlist_items_unique_per_user;

-- ── 2. updated_at was not clamped on insert ─────────────────────────────────
-- set_updated_at() clamps a future stamp to now() and keeps the newer write,
-- and it already handles INSERT, but on these five tables it only ran BEFORE
-- UPDATE. A row first inserted from a device whose clock ran ahead kept that
-- future stamp, and later edits from devices with correct clocks lost to it
-- as "older". Same function, now on insert too.
drop trigger if exists goals_set_updated_at on public.goals;
create trigger goals_set_updated_at
  before insert or update on public.goals
  for each row execute function public.set_updated_at();

drop trigger if exists manual_assets_set_updated_at on public.manual_assets;
create trigger manual_assets_set_updated_at
  before insert or update on public.manual_assets
  for each row execute function public.set_updated_at();

drop trigger if exists portfolio_lots_set_updated_at on public.portfolio_lots;
create trigger portfolio_lots_set_updated_at
  before insert or update on public.portfolio_lots
  for each row execute function public.set_updated_at();

drop trigger if exists watchlist_items_set_updated_at on public.watchlist_items;
create trigger watchlist_items_set_updated_at
  before insert or update on public.watchlist_items
  for each row execute function public.set_updated_at();

drop trigger if exists set_work_quality_logs_updated_at on public.work_quality_logs;
create trigger set_work_quality_logs_updated_at
  before insert or update on public.work_quality_logs
  for each row execute function public.set_updated_at();
