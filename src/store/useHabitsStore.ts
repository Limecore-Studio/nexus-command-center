// ─── v1.2 Habit Tracker store ────────────────────────────────────────────
//
// Cloud-synced via Supabase `habits` + `habit_completions` tables. Local
// Dexie holds the authoritative working set; mutations enqueue the cloud
// shape and the realtime channel echoes other devices' writes back.
//
// Selectors live alongside the store to keep streak math cheap and free of
// the React hooks-rules trap (callers pull a slice + run the helper).
// streakFor(habitId) does the per-habit compute on demand from the
// completions slice — typical habit count is < 30 so a recompute per render
// is essentially free.
//
// Reminder side-effects:
//   - addHabit / updateHabit reschedule via scheduleHabitReminder (idempotent
//     by ID). If reminderTime cleared → cancelHabitReminder.
//   - deleteHabit / archiveHabit always cancels.
//   - load() sweeps all active habits and re-arms reminders. The evening and
//     morning nudges are one-shot and a specific-days primary is too, so
//     re-arming on load is what keeps them rolling. A daily habit's primary
//     re-arms itself natively (v1.18.1, NCC#138); load() refreshes it.
//   - load() also cancels any habit alarm no active habit owns (v1.18.1,
//     NCC#138): a habit archived, deleted or cleared of its reminder on
//     another device arrives by sync, which never cancelled anything, and its
//     daily reminder would otherwise repeat for good.
//   - rearmHabitsWhenNotificationsOn() re-arms every habit when the master
//     switch turns on (v1.18.1, NCC#151); turning it off cancels them.

import { create } from 'zustand';
import { db } from '../db/database';
import { generateId } from '../utils/uuid';
import { enqueue } from '../db/syncQueue';
import type { Habit, HabitCompletion } from '../types/habits';
import { computeStreak, dateKey, type StreakResult } from '../lib/habitStreaks';
import { scheduleHabitReminder, cancelHabitReminder, fireHabitMilestone, reconcileHabitReminders } from '../lib/habitReminders';
import { STREAK_MILESTONES } from '../lib/habitMessages';
import { useSettingsStore } from './useSettingsStore';

interface HabitsStore {
  habits: Habit[];
  /** All completions, across all habits — small enough to keep in memory.
   *  At 5 habits × 365 days × 1 year that's 1,825 rows. We aggregate via
   *  Map in the streak helper, so linear scans are fine. */
  completions: HabitCompletion[];
  loaded: boolean;

  load: () => Promise<void>;
  addHabit: (
    h: Omit<Habit, 'id' | 'createdAt' | 'updatedAt' | 'syncStatus' | 'archivedAt'>,
  ) => Promise<Habit>;
  updateHabit: (
    id: string,
    patch: Partial<Omit<Habit, 'id' | 'createdAt' | 'syncStatus'>>,
  ) => Promise<void>;
  archiveHabit: (id: string) => Promise<void>;
  restoreHabit: (id: string) => Promise<void>;
  deleteHabit: (id: string) => Promise<void>;

  /** Binary toggle for today (or any date). If a completion exists, deletes
   *  it; otherwise creates one with amount=1. Idempotent on rapid double-tap
   *  via the UNIQUE (habitId, date) — the redundant create no-ops at DB level
   *  and we re-read the truth from local state. */
  toggleCompletion: (habitId: string, date?: string) => Promise<void>;

  /** Set the completion amount for a date (quantified habits). amount=0
   *  deletes the completion row; amount>0 upserts. */
  setCompletionAmount: (habitId: string, amount: number, date?: string) => Promise<void>;

  /** Add to the completion amount for a date — common quantified flow
   *  ("logged 15 more minutes"). delta can be positive or negative; the
   *  result is clamped at 0 (which deletes the row). */
  addToCompletion: (habitId: string, delta: number, date?: string) => Promise<void>;

  /** Internal — fire a milestone celebration if the streak just hit 7/30/100/365. */
  _celebrateIfMilestone: (habitId: string) => void;

  /** Internal — re-arm a habit's reminders from current completion state so the
   *  one-shot evening/morning nudges cancel on log (and re-arm on un-log). */
  _rearmReminder: (habitId: string) => void;

  /** v1.18.1 (NCC#151) — _rearmReminder for every habit (no-op for archived
   *  ones and ones without a reminder). */
  rearmAllReminders: () => void;

  // ─── Selectors (no React hooks; pure derivations from current slice) ───
  streakFor: (habitId: string) => StreakResult;
  completionsFor: (habitId: string) => HabitCompletion[];
  completionForDate: (habitId: string, date: string) => HabitCompletion | undefined;
}

function sortHabits(habits: Habit[]): Habit[] {
  // Visible order: active first (sorted by createdAt asc — oldest at top
  // matches the "anchor habits" mental model), archived at the bottom.
  return [...habits].sort((a, b) => {
    if (!!a.archivedAt !== !!b.archivedAt) return a.archivedAt ? 1 : -1;
    return a.createdAt.localeCompare(b.createdAt);
  });
}

export const useHabitsStore = create<HabitsStore>((set, get) => ({
  habits: [],
  completions: [],
  loaded: false,

  async load() {
    const [habits, completions] = await Promise.all([
      db.habits.toArray(),
      db.habitCompletions.toArray(),
    ]);
    set({ habits: sortHabits(habits), completions, loaded: true });

    // Re-arm reminders on cold start with the current streak so copy + the
    // evening nudge are streak-aware. Fire-and-forget — the native plugin
    // tolerates batch scheduling, and any failure logs itself.
    get().rearmAllReminders();
    // v1.18.1 (NCC#138): and drop the alarms no active habit owns. Touches only
    // IDs the re-arm above does not, so the two can run side by side.
    void reconcileHabitReminders(get().habits);
  },

  rearmAllReminders() {
    for (const h of get().habits) get()._rearmReminder(h.id);
  },

  // v1.7 (BUG-3) — re-arm a single habit's reminders from current completion
  // state. Called after every completion toggle so the one-shot evening/morning
  // nudges are cancelled the moment the habit is logged (and re-scheduled if a
  // completion is undone). No-op for habits without a reminder / archived.
  _rearmReminder(habitId: string) {
    const habit = get().habits.find((h) => h.id === habitId);
    if (!habit || !habit.reminderTime || habit.archivedAt) return;
    const rows = get().completions.filter((c) => c.habitId === habitId);
    const st = computeStreak(habit, rows);
    void scheduleHabitReminder(habit, st.current, st.todayHit);
  },

  // Fire a one-off celebration if the habit's streak just landed on a
  // milestone (7/30/100/365). Called after a completion is recorded.
  _celebrateIfMilestone(habitId: string) {
    const habit = get().habits.find((h) => h.id === habitId);
    if (!habit) return;
    const rows = get().completions.filter((c) => c.habitId === habitId);
    const st = computeStreak(habit, rows);
    if ((STREAK_MILESTONES as readonly number[]).includes(st.current)) {
      void fireHabitMilestone(habit, st.current);
    }
  },

  async addHabit(input) {
    const now = new Date().toISOString();
    const habit: Habit = {
      id: generateId(),
      title: input.title,
      type: input.type,
      targetAmount: input.targetAmount,
      unit: input.unit,
      frequencyKind: input.frequencyKind,
      daysOfWeek: input.daysOfWeek,
      reminderTime: input.reminderTime,
      color: input.color,
      syncStatus: 'pending',
      createdAt: now,
      updatedAt: now,
    };
    await db.habits.add(habit);
    await enqueue('habit', habit.id, 'insert', habit);
    set({ habits: sortHabits([...get().habits, habit]) });
    if (habit.reminderTime) void scheduleHabitReminder(habit);
    return habit;
  },

  async updateHabit(id, patch) {
    const existing = await db.habits.get(id);
    if (!existing) return;
    const merged: Habit = {
      ...existing,
      ...patch,
      id,
      updatedAt: new Date().toISOString(),
      syncStatus: 'pending',
    };
    await db.habits.put(merged);
    await enqueue('habit', id, 'update', merged);
    set({ habits: sortHabits(get().habits.map((h) => (h.id === id ? merged : h))) });
    // Reminder bookkeeping — schedule when the row has a time and isn't
    // archived; cancel in every other case.
    if (merged.reminderTime && !merged.archivedAt) {
      // v1.18.1 (NCC#151): with today's streak and completion. Scheduling
      // `merged` alone meant streak 0 and "not done today", so renaming a
      // habit already done today still sent next morning's catch-up ping.
      get()._rearmReminder(id);
    } else {
      void cancelHabitReminder({ id });
    }
  },

  async archiveHabit(id) {
    await get().updateHabit(id, { archivedAt: new Date().toISOString() });
  },

  async restoreHabit(id) {
    await get().updateHabit(id, { archivedAt: undefined });
  },

  async deleteHabit(id) {
    // Cancel any standing reminder, then cascade-delete completions locally
    // (the cloud FK has ON DELETE CASCADE so the remote side cleans up too).
    void cancelHabitReminder({ id });
    const childCompletions = get().completions.filter((c) => c.habitId === id);
    for (const c of childCompletions) {
      await db.habitCompletions.delete(c.id);
      await enqueue('habit_completion', c.id, 'delete', { id: c.id, habitId: c.habitId, date: c.date });
    }
    await db.habits.delete(id);
    await enqueue('habit', id, 'delete', { id });
    set({
      habits: get().habits.filter((h) => h.id !== id),
      completions: get().completions.filter((c) => c.habitId !== id),
    });
  },

  async toggleCompletion(habitId, date) {
    const day = date ?? dateKey(new Date());
    const existing = get().completions.find(
      (c) => c.habitId === habitId && c.date === day,
    );
    if (existing) {
      await db.habitCompletions.delete(existing.id);
      await enqueue('habit_completion', existing.id, 'delete', { id: existing.id, habitId: existing.habitId, date: existing.date });
      set({ completions: get().completions.filter((c) => c.id !== existing.id) });
      get()._rearmReminder(habitId);
      return;
    }
    const now = new Date().toISOString();
    const row: HabitCompletion = {
      id: generateId(),
      habitId,
      date: day,
      amount: 1,
      syncStatus: 'pending',
      createdAt: now,
    };
    await db.habitCompletions.add(row);
    await enqueue('habit_completion', row.id, 'insert', row);
    set({ completions: [...get().completions, row] });
    get()._celebrateIfMilestone(habitId);
    get()._rearmReminder(habitId);
  },

  async setCompletionAmount(habitId, amount, date) {
    const day = date ?? dateKey(new Date());
    const clamped = Math.max(0, isFinite(amount) ? amount : 0);
    const existing = get().completions.find(
      (c) => c.habitId === habitId && c.date === day,
    );
    if (clamped === 0) {
      if (!existing) return;
      await db.habitCompletions.delete(existing.id);
      await enqueue('habit_completion', existing.id, 'delete', { id: existing.id, habitId: existing.habitId, date: existing.date });
      set({ completions: get().completions.filter((c) => c.id !== existing.id) });
      get()._rearmReminder(habitId);
      return;
    }
    if (existing) {
      const updated: HabitCompletion = { ...existing, amount: clamped, syncStatus: 'pending' };
      await db.habitCompletions.put(updated);
      await enqueue('habit_completion', existing.id, 'update', updated);
      set({
        completions: get().completions.map((c) => (c.id === existing.id ? updated : c)),
      });
      get()._celebrateIfMilestone(habitId);
      get()._rearmReminder(habitId);
      return;
    }
    const now = new Date().toISOString();
    const row: HabitCompletion = {
      id: generateId(),
      habitId,
      date: day,
      amount: clamped,
      syncStatus: 'pending',
      createdAt: now,
    };
    await db.habitCompletions.add(row);
    await enqueue('habit_completion', row.id, 'insert', row);
    set({ completions: [...get().completions, row] });
    get()._celebrateIfMilestone(habitId);
    get()._rearmReminder(habitId);
  },

  async addToCompletion(habitId, delta, date) {
    const day = date ?? dateKey(new Date());
    const existing = get().completions.find(
      (c) => c.habitId === habitId && c.date === day,
    );
    const next = (existing?.amount ?? 0) + delta;
    await get().setCompletionAmount(habitId, next, day);
  },

  streakFor(habitId) {
    const habit = get().habits.find((h) => h.id === habitId);
    if (!habit) {
      return { current: 0, longest: 0, todayHit: false, todayEligible: false };
    }
    const rows = get().completions.filter((c) => c.habitId === habitId);
    return computeStreak(habit, rows);
  },

  completionsFor(habitId) {
    return get().completions.filter((c) => c.habitId === habitId);
  },

  completionForDate(habitId, date) {
    return get().completions.find((c) => c.habitId === habitId && c.date === date);
  },
}));

/** v1.18.1 (NCC#151) — re-arm every habit's reminders once notifications can
 *  be scheduled: settings and habits both loaded and the master switch on.
 *  Runs then, and again each time the switch goes from off to on, never on an
 *  unrelated store change. Turning the switch off cancels the habits category
 *  (NotificationsSection), and neither the switch's on-path nor the first-run
 *  explainer re-armed them, so they stayed silent until the next cold start.
 *  Returns the unsubscriber. Mounted by NotificationBridge (App.tsx). */
export function rearmHabitsWhenNotificationsOn(): () => void {
  const ready = () => {
    const settings = useSettingsStore.getState();
    return settings.loaded && settings.notifMasterEnabled && useHabitsStore.getState().loaded;
  };
  let wasReady = ready();
  if (wasReady) useHabitsStore.getState().rearmAllReminders();
  const check = () => {
    const isReady = ready();
    if (isReady && !wasReady) useHabitsStore.getState().rearmAllReminders();
    wasReady = isReady;
  };
  const unsubSettings = useSettingsStore.subscribe(check);
  const unsubHabits = useHabitsStore.subscribe(check);
  return () => {
    unsubSettings();
    unsubHabits();
  };
}
