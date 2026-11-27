-- v1.22 (limecore#99, StudyDesk#246): send caps for kofi_alt_email_begin.
--
-- NOT APPLIED. Written for the limecore session to review; apply it only
-- through the usual owner-approved migration step, then redeploy nothing (the
-- Edge Function is unchanged: every new refusal is the existing
-- 'rate_limited' or 'busy' status, which the clients already show).
--
-- What 20261008_kofi_alt_email_verified.sql already limits, per account: one
-- send a minute, five a day. What it does not:
--   (a) The hourly breaker (30 other accounts sent in the last hour) can be
--       tripped by fresh accounts, which pauses the feature for everyone. Only
--       accounts with a confirmed login email now count towards it, and are
--       allowed to send at all; and no single address receives more than
--       three codes a day, whichever accounts ask.
--   (b) An account could spend its five daily sends on five different
--       addresses. Now at most three distinct addresses per account per day.
--
-- Both need a record of past sends, because kofi_alt_emails keeps only each
-- account's current address. The log keeps a hash of the address, not the
-- address, and rows older than two days are deleted by begin itself.

create table if not exists public.kofi_alt_email_sends (
  id          bigint generated always as identity primary key,
  user_id     uuid        not null references auth.users (id) on delete cascade,
  email_hash  text        not null,
  sent_at     timestamptz not null default now()
);

create index if not exists kofi_alt_email_sends_user_idx  on public.kofi_alt_email_sends (user_id, sent_at);
create index if not exists kofi_alt_email_sends_email_idx on public.kofi_alt_email_sends (email_hash, sent_at);

comment on table public.kofi_alt_email_sends is
  'One row per code sent by kofi_alt_email_begin (limecore#99): sha256 of the address, never the address. Server-side only; purged after two days.';

alter table public.kofi_alt_email_sends enable row level security;
revoke all on public.kofi_alt_email_sends from anon, authenticated;

create or replace function public.kofi_alt_email_begin(p_user uuid, p_email text, p_code text)
returns text
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_hash  text;
  v_row   public.kofi_alt_emails;
  v_fresh boolean;
begin
  if char_length(v_email) > 254 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    return 'invalid_email';
  end if;
  if coalesce(p_code, '') !~ '^[0-9]{6}$' then
    raise exception 'kofi_alt_email_begin: the code must be six digits';
  end if;
  -- (a) A confirmed login email is required, so the breaker below cannot be
  -- filled with throwaway sign-ups.
  if not exists (select 1 from auth.users u
                  where u.id = p_user and u.deleted_at is null
                    and coalesce(u.is_anonymous, false) = false
                    and u.email_confirmed_at is not null) then
    return 'no_user';
  end if;

  insert into public.kofi_alt_emails (user_id) values (p_user) on conflict (user_id) do nothing;
  select * into v_row from public.kofi_alt_emails where user_id = p_user for update;

  if v_row.email = v_email and v_row.verified_at is not null then
    return 'already_verified';
  end if;
  if v_row.last_sent_at > now() - interval '60 seconds' then
    return 'too_soon';
  end if;
  v_fresh := v_row.sends_window_started_at is null
             or v_row.sends_window_started_at <= now() - interval '24 hours';
  if not v_fresh and v_row.sends >= 5 then
    return 'rate_limited';
  end if;

  delete from public.kofi_alt_email_sends where sent_at < now() - interval '2 days';
  v_hash := encode(sha256(convert_to(v_email, 'UTF8')), 'hex');

  -- (b) At most three distinct addresses per account per day. Re-sending to
  -- an address already tried today does not count as a new one.
  if not exists (select 1 from public.kofi_alt_email_sends s
                  where s.user_id = p_user and s.email_hash = v_hash
                    and s.sent_at > now() - interval '24 hours')
     and (select count(distinct s.email_hash) from public.kofi_alt_email_sends s
           where s.user_id = p_user and s.sent_at > now() - interval '24 hours') >= 3 then
    return 'rate_limited';
  end if;

  -- (a) At most three codes per address per day, from any accounts.
  if (select count(*) from public.kofi_alt_email_sends s
       where s.email_hash = v_hash and s.sent_at > now() - interval '24 hours') >= 3 then
    return 'rate_limited';
  end if;

  if (select count(*) from public.kofi_alt_emails a
       where a.user_id <> p_user and a.last_sent_at > now() - interval '1 hour') >= 30 then
    return 'busy';
  end if;

  update public.kofi_alt_emails set
    email                   = v_email,
    verified_at             = null,
    code_hash               = encode(sha256(convert_to(p_user::text || ':' || v_email || ':' || p_code, 'UTF8')), 'hex'),
    code_expires_at         = now() + interval '15 minutes',
    attempts                = 0,
    sends                   = case when v_fresh then 1 else sends + 1 end,
    sends_window_started_at = case when v_fresh then now() else sends_window_started_at end,
    last_sent_at            = now(),
    updated_at              = now()
  where user_id = p_user;

  insert into public.kofi_alt_email_sends (user_id, email_hash) values (p_user, v_hash);
  return 'sent';
end;
$$;

revoke all on function public.kofi_alt_email_begin(uuid, text, text) from public, anon, authenticated;
grant execute on function public.kofi_alt_email_begin(uuid, text, text) to service_role;
