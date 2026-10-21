-- v1.18.1 (NCC#193) — keep a task's due time.
--
-- tasks.due_date is a `date`. Add Task stores a full instant, so the time was
-- dropped on every push, and the next pull handed the device back a bare day
-- (shown as 03:00 in Helsinki). due_at holds the instant; due_date stays for
-- clients before 1.18.1 and now carries the user's local day.
--
-- A pre-1.18.1 client doesn't send due_at, so an upsert from it leaves the
-- old instant in place. If such a client moves the due day, the guard below
-- clears due_at, and every client then reads the new day from due_date.

alter table public.tasks add column if not exists due_at timestamptz;

create or replace function public.tasks_due_at_guard()
returns trigger
language plpgsql
set search_path to ''
as $$
begin
  if new.due_date is distinct from old.due_date
     and new.due_at is not distinct from old.due_at
     and new.due_at is not null then
    new.due_at := null;
  end if;
  return new;
end;
$$;

drop trigger if exists tasks_due_at_guard on public.tasks;
create trigger tasks_due_at_guard
  before update on public.tasks
  for each row execute function public.tasks_due_at_guard();
