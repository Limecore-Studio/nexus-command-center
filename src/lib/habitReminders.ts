// ─── Habit reminders (v1.5.2 — Duolingo-style) ──────────────────────────
//
// Each habit with a reminderTime gets, on every app open (the store re-arms in
// load()), up to three local notifications:
//
//   1. PRIMARY      at reminderTime — varied copy. Repeats daily for a daily
//                   habit (so it never carries the streak; see below). A
//                   specific-days habit has one alarm per chosen weekday
//                   instead, each repeating weekly (v1.18.1, NCC#168).
//   2. EVENING NUDGE ~3h later (daily habits only, streak > 0, capped ≤ 21:00)
//                   — soft "streak at risk" message.
//   3. MORNING CATCH-UP at 08:00 (daily habits only) — "did you do it last
//                   night? tap to log" → deep-links to the habit's catch-up
//                   strip. Built for habits done away from the phone (reading
//                   in bed, etc.). Copy is graceful whether or not it was done.
//
// Plus a one-off MILESTONE celebration fired immediately from the store when a
// completion crosses 7 / 30 / 100 / 365 days.
//
// Native constraint: scheduled alarms can't check "is it logged?" at fire time.
// We lean on (a) graceful copy and (b) re-arming on every app open + cancelling
// on in-app completion to keep nags honest. Worst case the user gets one soft,
// well-worded nudge they can ignore.
//
// v1.7 (BUG-3) — the evening nudge and morning catch-up assert a state
// ("streak at risk" / "did you do it last night?") that's simply wrong once the
// habit is already done. Previously they were scheduled `every: 'day'`, so a
// repeating alarm kept firing that false claim the next morning even after the
// habit was logged. Fix: (1) both are now completion-aware — suppressed when
// today is already done — and (2) both are ONE-SHOT (next occurrence only),
// re-armed on every app open AND on every in-app completion toggle (the store
// now re-arms in toggleCompletion / setCompletionAmount). The daily primary
// reminder stays repeating, so a user who stops opening the app still gets
// their daily prompt.
//
// v1.18.1 (NCC#138): it really repeats now (the native receiver re-arms it),
// with the text it was scheduled with. This note used to call that text
// state-neutral; it was streak-aware ("12-day streak"), and a repeat kept
// showing the count after the streak broke. A repeating reminder now takes the
// streak-free 'repeating' copy (habitMessages.ts).
//
// v1.18.1 (NCC#168): a specific-days habit's reminder was one-shot: it fired
// on the next chosen day and then stayed silent until NCC was opened. Each
// chosen weekday now has its own alarm, which the native receiver re-arms for
// the same weekday a week later (every: 'week'), with the streak-free
// 'repeating' copy for the same reason as the daily one.
//
// ID allocation inside the habits range (8000-11099), by slot 0..299:
//   8000 + slot*3 + {0,1,2}  → {primary, evening, morning} of a daily habit
//   8990-8998                → milestones, shared, one-off so collisions are
//                              harmless (hash % 300 % 9, as before)
//   9000 + slot*7 + weekday  → a specific-days habit's reminder on that
//                              weekday (0 = Sunday .. 6 = Saturday)
// A habit owns the IDs of its current kind only (ownedHabitReminderIds), so
// switching kind, or dropping a weekday, leaves alarms that
// reconcileHabitReminders cancels. Scheduling never cancels another kind's
// IDs or another weekday's itself: only reconcile knows which habit owns what.
//
// v1.18.1 (NCC#178) — the slot was hash(id) % 300, so two habits could share
// one (~14% with 10 habits) and overwrite each other's alarms. Slots are now
// assigned: a per-device map habitId → slot in Capacitor Preferences (Android
// SharedPreferences), read once per run. A habit that needs a slot gets its
// old hash slot when free, so an upgrade keeps most IDs as they were, else
// the lowest free one. Reconcile frees the slot of a habit deleted, archived
// or cleared of its reminder once it has cancelled that habit's alarms.
// Alarms left under hashed IDs a habit no longer owns are cancelled by the
// same reconcile (it cancels every unowned ID in the range from getPending).
// The native receiver re-arms by the ID in its intent and never recomputes
// it. Past 300 habits with reminders the extra ones get no slot: they are
// skipped and logged, never given another habit's IDs.

import { scheduleNotification, cancelNotifications, pendingIdsIn, ID_RANGES } from './notifications';
import { Preferences } from '@capacitor/preferences';
import { habitMessage } from './habitMessages';
import type { Habit } from '../types/habits';

const SLOT_COUNT = 300;
const SLOTS_KEY = 'habits.reminderSlots';

/** The pre-NCC#178 slot: the one a habit's alarms were under before slots
 *  were assigned, preferred when free. */
export function habitHashSlot(habitId: string): number {
  let h = 5381;
  for (let i = 0; i < habitId.length; i++) h = ((h << 5) + h + habitId.charCodeAt(i)) | 0;
  return Math.abs(h) % SLOT_COUNT;
}

const MILESTONE_BASE = ID_RANGES.habits.base + 990; // 8990-8998
// v1.18.1 (NCC#168): 9000-11099, 7 per slot.
const WEEKDAY_BASE = ID_RANGES.habits.base + 1000;

// v1.18.1 (NCC#178): habitId → slot, loaded once per run.
let slots: Map<string, number> | undefined;
let slotsLoad: Promise<void> | undefined;
let slotsSave: Promise<void> = Promise.resolve();
// v1.18.1 (NCC#178): scheduling and reconcile run one at a time, in call
// order. Overlapping, a reconcile could free a slot (or cancel an alarm) that
// a schedule of the same habit had just used. A failure does not stop the
// queue.
let queue: Promise<unknown> = Promise.resolve();
function serial(fn: () => Promise<void>): Promise<void> {
  const run = queue.then(fn);
  queue = run.catch(() => {});
  return run;
}

/** v1.18.1 (NCC#178): read the slot map; every scheduling path awaits it.
 *  Unreadable or missing → empty, and habits take their hash slots again. A
 *  slot listed twice keeps its first habit. */
export function loadHabitSlots(): Promise<void> {
  return (slotsLoad ??= Preferences.get({ key: SLOTS_KEY })
    .then(({ value }) => Object.entries((JSON.parse(value || '{}') ?? {}) as Record<string, unknown>))
    .catch(() => [] as [string, unknown][])
    .then((entries) => {
      const m = new Map<string, number>();
      const used = new Set<number>();
      for (const [id, s] of entries) {
        if (typeof s !== 'number' || !Number.isInteger(s) || s < 0 || s >= SLOT_COUNT || used.has(s)) continue;
        m.set(id, s);
        used.add(s);
      }
      slots = m;
    }));
}

/** v1.18.1 (NCC#178): queued so writes land in order, each with the map as
 *  it is when it runs. */
function saveSlots(): void {
  slotsSave = slotsSave
    .then(() => Preferences.set({ key: SLOTS_KEY, value: JSON.stringify(Object.fromEntries(slots ?? [])) }))
    .catch((e) => console.warn('[habits] slots not saved', e));
}

/** v1.18.1 (NCC#178): a habit's slot, assigned on first need (its hash slot
 *  when free, else the lowest free one; `hashOnly`: else none). null when
 *  all 300 are taken. Call after loadHabitSlots(). */
function slotOf(habitId: string, hashOnly = false): number | null {
  if (!slots) throw new Error('slots not loaded');
  const held = slots.get(habitId);
  if (held !== undefined) return held;
  const used = new Set(slots.values());
  let s = habitHashSlot(habitId);
  if (hashOnly && used.has(s)) return null;
  for (let i = 0; used.has(s) && i < SLOT_COUNT; i++) s = i;
  if (used.has(s)) {
    console.warn('[habits] no free reminder slot; skipped', habitId);
    return null;
  }
  slots.set(habitId, s);
  saveSlots();
  return s;
}

const dailyIds = (slot: number) => [0, 1, 2].map((k) => ID_RANGES.habits.base + slot * 3 + k);
const weekdayIds = (slot: number) => [0, 1, 2, 3, 4, 5, 6].map((d) => WEEKDAY_BASE + slot * 7 + d);

/** The daily reminder alarm IDs of a habit: primary, evening, morning.
 *  v1.18.1 (NCC#178): its own; empty past 300 habits. Assigns its slot if it
 *  has none, so call after loadHabitSlots(). */
export function habitReminderIds(habitId: string): number[] {
  const slot = slotOf(habitId);
  return slot === null ? [] : dailyIds(slot);
}

/** v1.18.1 (NCC#168): the alarm ID of a specific-days habit's reminder on one
 *  weekday (0 = Sunday .. 6 = Saturday, as Date.getDay()). v1.18.1 (NCC#178):
 *  as habitReminderIds; throws past 300 habits. */
export function habitWeekdayReminderId(habitId: string, weekday: number): number {
  const slot = slotOf(habitId);
  if (slot === null) throw new Error('no slot');
  return weekdayIds(slot)[weekday];
}

/** v1.18.1 (NCC#168): the chosen weekdays of a specific-days habit, valid
 *  and without repeats. */
function chosenWeekdays(habit: Pick<Habit, 'daysOfWeek'>): Set<number> {
  return new Set((habit.daysOfWeek ?? []).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6));
}

/** v1.18.1 (NCC#168): the reminder alarm IDs a habit uses as it is now: none
 *  without a usable reminder or when archived, primary/evening/morning for a
 *  daily habit, one per chosen weekday for a specific-days habit. */
export function ownedHabitReminderIds(habit: Habit): number[] {
  if (!wantsSlot(habit)) return [];
  const slot = slotOf(habit.id);
  if (slot === null) return [];
  if (habit.frequencyKind === 'daily') return dailyIds(slot);
  const ids = weekdayIds(slot);
  return [...chosenWeekdays(habit)].map((d) => ids[d]);
}

/** v1.18.1 (NCC#178): an active habit with a usable reminder time holds a
 *  slot; any other gives it up at the next reconcile. */
function wantsSlot(habit: Habit): boolean {
  return !!habit.reminderTime && !habit.archivedAt && !!parseHHMM(habit.reminderTime);
}

function isMilestoneId(id: number): boolean {
  return id >= MILESTONE_BASE && id < WEEKDAY_BASE;
}

/** v1.18.1 (NCC#138): cancel every alarm in the habits range that no active
 *  habit with a reminder owns. A daily reminder now re-arms itself natively,
 *  so one belonging to a habit archived, deleted or cleared of its reminder on
 *  another device (and synced here) fired every day for good: the in-app paths
 *  cancel their own alarms, sync never did. IDs an active habit owns are kept,
 *  not wiped and re-armed. Milestones are left alone; they are one-off and
 *  fire within seconds.
 *
 *  v1.18.1 (NCC#168): what a habit owns depends on its kind and days, so a
 *  weekday alarm left by a habit since switched to daily, or by a day
 *  dropped on another device, goes too.
 *
 *  v1.18.1 (NCC#178): it also assigns the slots active habits lack and frees
 *  the slots of the rest, after cancelling. After an upgrade, alarms under a
 *  hashed ID their habit no longer owns are unowned, so they go here too.
 *  The store runs it before re-arming on load(), so on an upgrade it is what
 *  assigns the slots. */
export function reconcileHabitReminders(habits: Habit[]): Promise<void> {
  return serial(() => reconcile(habits));
}

async function reconcile(habits: Habit[]): Promise<void> {
  await loadHabitSlots();
  // v1.18.1 (NCC#178): oldest first, every habit whose hash slot is free
  // takes it, then the rest the lowest free ones, so the fewest IDs move.
  const want = habits.filter(wantsSlot).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const h of want) slotOf(h.id, true);
  const owned = new Set(want.flatMap(ownedHabitReminderIds));
  // v1.18.1 (NCC#178): nothing is cancelled or freed when the pending list or
  // the cancel failed; the next reconcile tries again.
  const pending = await pendingIdsIn('habits');
  if (!pending) return;
  if (!(await cancelNotifications(pending.filter((id) => !isMilestoneId(id) && !owned.has(id))))) return;
  // Their alarms are cancelled, so their slots can go to the next habit.
  const keep = new Set(want.map((h) => h.id));
  let freed = false;
  for (const id of slots!.keys()) if (!keep.has(id)) freed = slots!.delete(id);
  if (freed) saveSlots();
}

function parseHHMM(s: string): { hour: number; minute: number } | null {
  const m = s.match(/^([0-2]?\d):([0-5]\d)$/);
  if (!m) return null;
  const hour = parseInt(m[1], 10);
  const minute = parseInt(m[2], 10);
  if (hour < 0 || hour > 23) return null;
  return { hour, minute };
}

/** hour:minute on the day `offset` days after `from`. v1.18.1 (NCC#168): the
 *  day first, then the time. Set on today first, a time in a skipped DST hour
 *  (02:30 on a spring-forward day) became 03:30 and stayed 03:30 on the day it
 *  was then moved to. */
function atDayOffset(from: Date, offset: number, hour: number, minute: number): Date {
  const c = new Date(from);
  c.setDate(c.getDate() + offset);
  c.setHours(hour, minute, 0, 0);
  return c;
}

function nextDailyFire(hour: number, minute: number, from: Date = new Date()): Date {
  const c = atDayOffset(from, 0, hour, minute);
  return c.getTime() > from.getTime() ? c : atDayOffset(from, 1, hour, minute);
}

function nextSpecificDaysFire(hour: number, minute: number, daysOfWeek: number[], from: Date = new Date()): Date | null {
  if (daysOfWeek.length === 0) return null;
  for (let offset = 0; offset < 8; offset++) {
    const probe = atDayOffset(from, offset, hour, minute);
    if (probe.getTime() <= from.getTime()) continue;
    if (daysOfWeek.includes(probe.getDay())) return probe;
  }
  return null;
}

/** Schedule (or re-schedule) a habit's reminders. Pass the current streak so
 *  the copy + evening nudge are streak-aware, and `completedToday` so the
 *  evening/morning nudges don't nag about a habit that's already logged.
 *  Idempotent by ID. */
export function scheduleHabitReminder(habit: Habit, streak = 0, completedToday = false): Promise<void> {
  return serial(() => schedule(habit, streak, completedToday));
}

async function schedule(habit: Habit, streak: number, completedToday: boolean): Promise<void> {
  // No reminder / archived / malformed → nothing to schedule. v1.18.1
  // (NCC#168, NCC#178): what it had is left to reconcileHabitReminders, which
  // the store runs after every habit change and which frees its slot.
  if (!habit.reminderTime || habit.archivedAt) return;
  const parsed = parseHHMM(habit.reminderTime);
  if (!parsed) return;
  await loadHabitSlots();
  // v1.18.1 (NCC#178): no free slot (300 habits with reminders) → skipped;
  // slotOf logged it.
  const slot = slotOf(habit.id);
  if (slot === null) return;
  const [primary, evening, morning] = dailyIds(slot);

  // v1.18.1 (NCC#168): a specific-days habit has its own alarms, one per
  // chosen weekday, and no evening nudge or morning catch-up (their messaging
  // assumes "every day"; specific-days eligibility would make them misleading).
  if (habit.frequencyKind !== 'daily') {
    await scheduleWeekdayReminders(habit, slot, parsed);
    return;
  }
  // A habit switched from specific days to daily leaves its weekday alarms;
  // reconcileHabitReminders cancels them (see the ID allocation note).

  // ── 1. Primary reminder ──────────────────────────────────────────────
  // v1.18.1 (NCC#138): a repeating reminder shows this text every day, so it
  // must not carry today's streak.
  const m = habitMessage('repeating', habit.title, 0);
  await scheduleNotification({
    id: primary,
    category: 'habits',
    title: m.title,
    body: m.body,
    at: nextDailyFire(parsed.hour, parsed.minute),
    every: 'day',
    dailyTime: parsed,
    extra: { route: '/habits', habitId: habit.id },
  });

  // ── 2. Evening risk nudge — only when there's a streak to protect, the
  //       habit ISN'T already done today, and ~3h after the reminder still
  //       lands at a sane hour (≤ 21:00). One-shot (next occurrence): re-armed
  //       on app open + on completion, so a same-day log cancels it instead of
  //       a repeating alarm asserting "at risk" after it's already done.
  if (streak > 0 && eveningHourInRange(parsed.hour) && !completedToday) {
    const m = habitMessage('evening', habit.title, streak);
    await scheduleNotification({
      id: evening,
      category: 'habits',
      title: m.title,
      body: m.body,
      at: nextDailyFire(parsed.hour + 3, parsed.minute),
      extra: { route: `/habits?catchup=${habit.id}`, habitId: habit.id },
    });
  } else {
    await cancelNotifications([evening]);
  }

  // ── 3. Morning catch-up at 08:00 — log last night's habit from bed-time.
  //       Suppressed when today is already logged (nothing to catch up on —
  //       this was the "fires next morning even though I did it" bug). One-shot
  //       + re-armed, same as the evening nudge.
  if (!completedToday) {
    const mm = habitMessage('morning', habit.title, streak);
    await scheduleNotification({
      id: morning,
      category: 'habits',
      title: mm.title,
      body: mm.body,
      at: nextDailyFire(8, 0),
      extra: { route: `/habits?catchup=${habit.id}`, habitId: habit.id },
    });
  } else {
    await cancelNotifications([morning]);
  }
}

/** v1.18.1 (NCC#168): a specific-days habit's reminders. Each chosen weekday
 *  gets an alarm at the next such day, repeating weekly (the native receiver
 *  re-arms it a week on). The other weekdays, and the daily IDs (a habit
 *  switched from daily, or a v1.18.0 one-shot primary), are left to
 *  reconcileHabitReminders. The text repeats unchanged, so it is the
 *  streak-free 'repeating' copy. */
async function scheduleWeekdayReminders(
  habit: Habit,
  slot: number,
  time: { hour: number; minute: number },
): Promise<void> {
  const ids = weekdayIds(slot);
  const m = habitMessage('repeating', habit.title, 0);
  for (const weekday of chosenWeekdays(habit)) {
    const at = nextSpecificDaysFire(time.hour, time.minute, [weekday]);
    if (!at) continue;
    await scheduleNotification({
      id: ids[weekday],
      category: 'habits',
      title: m.title,
      body: m.body,
      at,
      every: 'week',
      weeklyTime: { weekday, ...time },
      extra: { route: '/habits', habitId: habit.id },
    });
  }
}

/** ~3h after the reminder still lands at or before 21:00 (a sane evening). */
function eveningHourInRange(reminderHour: number): boolean {
  return reminderHour + 3 <= 21;
}

/** Fire a one-off streak-milestone celebration immediately. Called from the
 *  store when a completion pushes the streak onto a milestone. */
export async function fireHabitMilestone(habit: Pick<Habit, 'id' | 'title'>, streak: number): Promise<void> {
  const m = habitMessage('milestone', habit.title, streak);
  await scheduleNotification({
    // v1.18.1 (NCC#178): off the hash, as before; it needs no slot.
    id: MILESTONE_BASE + (habitHashSlot(habit.id) % 9),
    category: 'habits',
    title: m.title,
    body: m.body,
    at: new Date(Date.now() + 1500), // ~immediate
    extra: { route: '/habits', habitId: habit.id },
  });
}
