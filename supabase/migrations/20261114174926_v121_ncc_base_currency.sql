-- v1.21 (NCC#248): the account's base currency once anyone converts. Additive, nullable.
alter table public.user_preferences
  add column if not exists ncc_base_currency text
  constraint user_preferences_ncc_base_currency_shape
    check (ncc_base_currency is null or ncc_base_currency ~ '^[A-Z]{3}$');

grant select (ncc_base_currency), insert (ncc_base_currency), update (ncc_base_currency)
  on public.user_preferences to authenticated;
