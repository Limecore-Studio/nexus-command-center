-- v1.21.1 (limecore#101): may `suite-session` mint for this token's session?
--
-- suite-session now accepts an access token up to 7 days past `exp` (it
-- verifies the token itself; see supabase/functions/suite-session/verify.ts),
-- so it must know the session behind the token is still alive: a sign-out or
-- a revoked session deletes the row in auth.sessions, and a deleted user
-- takes its sessions with it (ON DELETE CASCADE).
--
-- Additive: one new function, nothing else changes. SECURITY DEFINER so the
-- service role can read auth.sessions through it without any grant on the
-- auth schema; it answers a single boolean and returns no session data.
-- Callable by the service role only (P2: grants in the same migration).

create or replace function public.suite_session_alive(p_session_id uuid, p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from auth.sessions s
    where s.id = p_session_id
      and s.user_id = p_user_id
      and (s.not_after is null or s.not_after > now())
  );
$$;

revoke all on function public.suite_session_alive(uuid, uuid) from public;
revoke all on function public.suite_session_alive(uuid, uuid) from anon, authenticated;
grant execute on function public.suite_session_alive(uuid, uuid) to service_role;

comment on function public.suite_session_alive(uuid, uuid) is
  'v1.21.1 limecore#101: true while the session exists for that user. Service role only (suite-session).';
