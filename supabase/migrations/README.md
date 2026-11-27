# supabase/migrations

These files are a record of schema changes made to the shared Supabase project.
They are applied by the owner through the reviewed migration step, never by an
app build.

## Superseded: `kofi_match_user` in this folder (v1.22, limecore#113)

`20260823_supporter_entitlements.sql` and `20261005_kofi_match_follows_email_change.sql`
define `kofi_match_user` with a tier that trusts `raw_user_meta_data->>'kofi_alt_email'`.
That tier was replaced in production by the verified alternate-address flow
(limecore#55): `kofi_alt_emails` plus the `kofi_alt_email_*` functions, migration
`20261008_kofi_alt_email_verified.sql`, which lives in the private `limecore`
repository together with the `20260830` supporter migration.

So a local stack built from this folder alone is **not** production for
supporter matching. Do not apply these two files to rebuild or repair the
live `kofi_match_user`; take the current body from production (or from
limecore's migrations) instead. They stay here unchanged as history.
