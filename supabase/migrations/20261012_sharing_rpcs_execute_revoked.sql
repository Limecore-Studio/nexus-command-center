-- v1.18.1 (NCC#157) — record the sharing RPC grants as production has them.
--
-- OWNER APPLIES. On production this changes nothing: these three functions
-- are already executable only by postgres and service_role (checked
-- 2026-10-12). The revoke was done by hand, and the only migration that
-- touched these grants (20260511181046) GRANTs them to authenticated, so a
-- fresh environment built from migrations would switch sharing back on. This
-- file makes the migration history match production.
--
-- Sharing stays off in the app as well (SHARING_ENABLED in src/lib/sharing.ts).
-- Turning it back on is tracked in Limekana/limecore#62.
--
-- Guarded: the functions are created by migrations that live outside this
-- repo, so a database without them skips each revoke instead of failing.

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.share_task(uuid, text, text)',
    'public.share_budget_category(uuid, text, text)',
    'public.get_public_profiles(uuid[])'
  ] loop
    if to_regprocedure(fn) is not null then
      execute format('revoke execute on function %s from public, anon, authenticated', fn);
    end if;
  end loop;
end
$$;
