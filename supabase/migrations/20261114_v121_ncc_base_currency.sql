-- v1.21 (NCC#248): the account's base currency, so one NCC device's
-- conversion (NCC#244) is followed by the others instead of each showing
-- converted amounts under its own per-device label.
--
-- Additive and nullable. NULL means "never converted": devices keep their own
-- per-device setting exactly as before, so nothing changes for anyone until
-- they convert. Only the conversion writes it (conditionally, see
-- src/lib/baseCurrencyCloud.ts). Older NCC builds never read or write it, and
-- an upsert from them does not touch it.
--
-- NCC-only, like ncc_onboarded. StudyDesk and LimeLog never read it.

alter table public.user_preferences
  add column if not exists ncc_base_currency text
  constraint user_preferences_ncc_base_currency_shape
    check (ncc_base_currency is null or ncc_base_currency ~ '^[A-Z]{3}$');

-- The table's other columns are granted per column; grant this one the same
-- way so a client can read it and claim it. RLS ("Users manage own prefs",
-- user_id = auth.uid()) still applies.
grant select (ncc_base_currency), insert (ncc_base_currency), update (ncc_base_currency)
  on public.user_preferences to authenticated;
