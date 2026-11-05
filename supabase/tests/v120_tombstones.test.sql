-- NCC#92 (v1.20) — checks for 20261030_v120_tombstones.sql, run against a
-- local Supabase stack loaded with every production migration (the real
-- triggers and constraints), never production. Everything runs in one
-- transaction that is rolled back.
--
-- Run:
--   psql "$LOCAL_DB_URL" -v ON_ERROR_STOP=1 \
--     -f supabase/migrations/20261030_v120_tombstones.sql \
--     -f supabase/tests/v120_tombstones.test.sql
--
-- One PASS/FAIL line per check, then a summary; the final RAISE makes psql exit
-- non-zero if anything failed.

\set ON_ERROR_STOP 1
set client_min_messages = notice;
begin;

create temp table results (name text, ok boolean);

-- A throwaway user (rolled back with everything else).
insert into auth.users (id, email) values ('11111111-1111-1111-1111-111111111111', 'tomb@test.local');

insert into results
select 'deleted_at added, nullable: ' || t,
       exists (select 1 from information_schema.columns
                where table_schema = 'public' and table_name = t
                  and column_name = 'deleted_at' and is_nullable = 'YES'
                  and data_type = 'timestamp with time zone')
  from unnest(array['habits', 'habit_completions', 'work_quality_logs', 'braindump_entries']) t;

-- ── fixtures ────────────────────────────────────────────────────────────────
insert into public.habits (id, user_id, title, type, frequency_kind) values
  ('22222222-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'Read', 'binary', 'daily'),
  ('22222222-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'Run', 'quantified', 'daily');
insert into public.habit_completions (id, habit_id, user_id, date, amount) values
  ('33333333-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', '2026-10-01', 1),
  ('33333333-0000-0000-0000-000000000002', '22222222-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', '2026-10-01', 3);
insert into public.work_quality_logs (id, user_id, log_date, rating, updated_at) values
  ('44444444-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', '2026-10-01', 3, now() - interval '1 hour');
insert into public.braindump_entries (id, user_id, content) values
  ('55555555-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'idea');

-- ── a tombstone lands ───────────────────────────────────────────────────────
update public.habit_completions set deleted_at = now() where id = '33333333-0000-0000-0000-000000000001';
insert into results select 'completion tombstone lands',
  (select deleted_at is not null from public.habit_completions where id = '33333333-0000-0000-0000-000000000001');

update public.habits set deleted_at = now(), updated_at = now() where id = '22222222-0000-0000-0000-000000000002';
insert into results select 'habit tombstone lands',
  (select deleted_at is not null from public.habits where id = '22222222-0000-0000-0000-000000000002');

update public.work_quality_logs set deleted_at = now(), updated_at = now() where id = '44444444-0000-0000-0000-000000000001';
insert into results select 'work log tombstone lands (delete wins)',
  (select deleted_at is not null from public.work_quality_logs where id = '44444444-0000-0000-0000-000000000001');

-- ── an edit cannot undo a habit delete (upserts never send deleted_at) ──────
update public.habits set title = 'Run more' where id = '22222222-0000-0000-0000-000000000002';
insert into results select 'habit edited after delete stays deleted',
  (select deleted_at is not null from public.habits where id = '22222222-0000-0000-0000-000000000002');

-- ── re-marking a cleared day ────────────────────────────────────────────────
-- An older build re-sending the identical row (a queue retry): stays cleared.
update public.habit_completions set amount = 1
 where habit_id = '22222222-0000-0000-0000-000000000001' and date = '2026-10-01';
insert into results select 'identical re-send does not revive a completion',
  (select deleted_at is not null from public.habit_completions where id = '33333333-0000-0000-0000-000000000001');

-- An older build re-marking with a new amount: revives (no deleted_at sent).
update public.habit_completions set amount = 2
 where habit_id = '22222222-0000-0000-0000-000000000001' and date = '2026-10-01';
insert into results select 'older build re-marking a day revives it',
  (select deleted_at is null and amount = 2 from public.habit_completions where id = '33333333-0000-0000-0000-000000000001');

-- v1.20 build: clears it, then re-marks the same amount with deleted_at: null.
update public.habit_completions set deleted_at = now() where id = '33333333-0000-0000-0000-000000000001';
update public.habit_completions set amount = 2, deleted_at = null
 where habit_id = '22222222-0000-0000-0000-000000000001' and date = '2026-10-01';
insert into results select 'v1.20 re-mark (deleted_at: null) revives even at the same amount',
  (select deleted_at is null from public.habit_completions where id = '33333333-0000-0000-0000-000000000001');

-- Work log: an older-stamped re-rate does not beat the delete...
update public.work_quality_logs set rating = 5, updated_at = now() - interval '2 hours'
 where id = '44444444-0000-0000-0000-000000000001';
insert into results select 'older re-rate does not revive a deleted work log (LWW)',
  (select deleted_at is not null and rating = 3 from public.work_quality_logs where id = '44444444-0000-0000-0000-000000000001');
-- ...a newer one from an older build (no deleted_at sent) does.
update public.work_quality_logs set rating = 5, updated_at = now()
 where id = '44444444-0000-0000-0000-000000000001';
insert into results select 'newer re-rate from an older build revives the work log',
  (select deleted_at is null and rating = 5 from public.work_quality_logs where id = '44444444-0000-0000-0000-000000000001');

-- The tombstoned day still holds its natural key: a new id for the same day
-- collides, as before (NCC then updates by the natural key).
insert into results select 'natural key still unique across tombstones', (
  select count(*) = 1 from public.habit_completions
   where habit_id = '22222222-0000-0000-0000-000000000001' and date = '2026-10-01');

-- ── purge ───────────────────────────────────────────────────────────────────
update public.habit_completions set deleted_at = now() - interval '100 days' where id = '33333333-0000-0000-0000-000000000001';
update public.habits set deleted_at = now() - interval '100 days' where id = '22222222-0000-0000-0000-000000000002';
update public.work_quality_logs set deleted_at = now() - interval '100 days', updated_at = now() where id = '44444444-0000-0000-0000-000000000001';
update public.braindump_entries set deleted_at = now() - interval '100 days', updated_at = now() where id = '55555555-0000-0000-0000-000000000001';

create temp table purged as select * from public.purge_soft_deleted();

insert into results select 'purge reports ' || t, exists (select 1 from purged where table_name = t)
  from unnest(array['habits', 'habit_completions', 'work_quality_logs', 'braindump_entries']) t;
insert into results select 'old completion tombstone purged',
  not exists (select 1 from public.habit_completions where id = '33333333-0000-0000-0000-000000000001');
insert into results select 'old habit tombstone purged, its live days with it',
  not exists (select 1 from public.habits where id = '22222222-0000-0000-0000-000000000002')
  and not exists (select 1 from public.habit_completions where id = '33333333-0000-0000-0000-000000000002');
insert into results select 'live habit kept',
  exists (select 1 from public.habits where id = '22222222-0000-0000-0000-000000000001');
insert into results select 'old work log and braindump tombstones purged',
  not exists (select 1 from public.work_quality_logs where id = '44444444-0000-0000-0000-000000000001')
  and not exists (select 1 from public.braindump_entries where id = '55555555-0000-0000-0000-000000000001');

-- ── report ──────────────────────────────────────────────────────────────────
select (case when ok then 'PASS ' else 'FAIL ' end) || name as result from results;
do $$
declare bad int;
begin
  select count(*) into bad from results where not ok;
  raise notice '% checks, % failed', (select count(*) from results), bad;
  if bad > 0 then raise exception 'v120_tombstones: % check(s) failed', bad; end if;
end $$;

rollback;
