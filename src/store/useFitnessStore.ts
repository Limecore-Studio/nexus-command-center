import { create } from 'zustand';
import { Preferences } from '@capacitor/preferences';
import { db } from '../db/database';
import { WorkoutSession, WorkoutSet, WorkoutType } from '../types/fitness';
import { generateId } from '../utils/uuid';
import { localDateKey } from '../utils/formatters';
import {
  healthCapability,
  hasHealthPermissions,
  requestHealthPermissions,
  readTodaySteps,
  readWeeklySteps,
  readLatestWeightKg,
} from '../utils/healthConnect';

const STEP_GOAL_KEY = 'fitness.stepGoal';
const MANUAL_WEIGHT_KEY = 'fitness.manualWeightKg';
const MANUAL_STEPS_KEY = 'fitness.manualSteps';
const HC_CONNECTED_KEY = 'fitness.hcConnected';
// Daily step snapshots, keyed by local YYYY-MM-DD. We persist whatever Health
// Connect (or a manual entry) reports for "today" as we observe it. Samsung
// Health doesn't backfill past days into HC, so without this, each day's data
// evaporates the next time the store loads. With this, the Weekly Steps chart
// retains the days it has seen and stops "sliding" day-by-day.
const STEP_HISTORY_KEY = 'fitness.stepHistory';
const HISTORY_RETENTION_DAYS = 60;

async function getPref(key: string): Promise<string | null> {
  try {
    const { value } = await Preferences.get({ key });
    return value;
  } catch {
    return localStorage.getItem(key);
  }
}
async function setPref(key: string, value: string): Promise<void> {
  try {
    await Preferences.set({ key, value });
  } catch {
    localStorage.setItem(key, value);
  }
}

function mondayOfThisWeek(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  const dow = d.getDay() === 0 ? 7 : d.getDay(); // 1..7, Mon=1
  d.setDate(d.getDate() - (dow - 1));
  return d;
}

function weekDateKeys(): string[] {
  const mon = mondayOfThisWeek();
  const keys: string[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(mon);
    d.setDate(mon.getDate() + i);
    keys.push(localDateKey(d));
  }
  return keys;
}

async function getStepHistory(): Promise<Record<string, number>> {
  const raw = await getPref(STEP_HISTORY_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, number>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function setStepHistory(hist: Record<string, number>): Promise<void> {
  // Prune anything older than retention to keep the map small.
  const cutoff = Date.now() - HISTORY_RETENTION_DAYS * 86400000;
  const pruned: Record<string, number> = {};
  for (const [k, v] of Object.entries(hist)) {
    const t = new Date(k + 'T00:00:00').getTime();
    if (isFinite(t) && t >= cutoff && typeof v === 'number' && v >= 0) {
      pruned[k] = v;
    }
  }
  await setPref(STEP_HISTORY_KEY, JSON.stringify(pruned));
}

// Build a Mon..Sun array by merging Health Connect's weekly aggregate with
// any locally-persisted daily snapshots. We prefer the larger value per day
// (HC may be 0 for past days even though our snapshot saw them earlier; or
// HC may have backfilled higher than our snapshot — either way, max() wins).
// Also snapshots today's count (from hcToday or manualToday) into history
// so we don't lose it on the next reload.
async function buildWeeklyWithHistory(
  hcWeekly: number[] | null,
  todayCount: number | null,
): Promise<number[]> {
  const hist = await getStepHistory();
  const todayKey = localDateKey(new Date());

  // Capture today before reading the chart, so today's bar shows even when
  // hcWeekly is null (manual mode) and we have only a manual entry.
  if (todayCount != null && todayCount >= 0) {
    const prior = hist[todayKey] ?? 0;
    if (todayCount > prior) {
      hist[todayKey] = todayCount;
      await setStepHistory(hist);
    }
  }

  const keys = weekDateKeys();
  return keys.map((key, i) => {
    const hc = hcWeekly?.[i] ?? 0;
    const local = hist[key] ?? 0;
    return Math.max(hc, local);
  });
}

type HealthSource = 'manual' | 'health-connect';

interface FitnessStore {
  sessions: (WorkoutSession & { sets: WorkoutSet[] })[];
  todaySession: (WorkoutSession & { sets: WorkoutSet[] }) | null;

  todaySteps: number | null;
  latestWeight: number | null;
  weeklySteps: number[]; // Mon..Sun

  stepGoal: number;
  source: HealthSource;
  hcAvailable: boolean;
  hcReason: string;
  syncing: boolean;
  lastSync: string | null;

  load: () => Promise<void>;
  startOrGetTodaySession: (type: WorkoutType) => Promise<string>;
  addSet: (sessionId: string, s: Omit<WorkoutSet, 'id' | 'sessionId' | 'createdAt'>) => Promise<void>;
  updateSet: (id: string, patch: Partial<WorkoutSet>) => Promise<void>;
  deleteSet: (id: string) => Promise<void>;
  deleteSession: (id: string) => Promise<void>;

  setStepGoal: (goal: number) => Promise<void>;
  setManualWeight: (kg: number | null) => Promise<void>;
  setManualSteps: (steps: number | null) => Promise<void>;

  connectHealthConnect: () => Promise<{ ok: boolean; reason?: string }>;
  syncHealthData: () => Promise<void>;
  disconnectHealthConnect: () => Promise<void>;
}

const today = () => new Date().toISOString().slice(0, 10);

export const useFitnessStore = create<FitnessStore>((set, get) => ({
  sessions: [],
  todaySession: null,
  todaySteps: null,
  latestWeight: null,
  weeklySteps: [0, 0, 0, 0, 0, 0, 0],
  stepGoal: 10000,
  source: 'manual',
  hcAvailable: false,
  hcReason: '',
  syncing: false,
  lastSync: null,

  async load() {
    // v1.18.1 (NCC#153): every session, newest first. This list was capped
    // at 20, and goals (workout_count, lift_pr), Year Review, Life and the
    // weekly review all read it: a "30 workouts" goal stopped at 20 and an
    // older PR read as 0. Nothing renders the list itself. The sets come in
    // one query rather than one per session, since the list is no longer short.
    const sessions = await db.workoutSessions.orderBy('date').reverse().toArray();
    const setsBySession = new Map<string, WorkoutSet[]>();
    const allSets = await db.workoutSets.where('sessionId').anyOf(sessions.map((s) => s.id)).toArray();
    for (const set of allSets) {
      const list = setsBySession.get(set.sessionId);
      if (list) list.push(set);
      else setsBySession.set(set.sessionId, [set]);
    }
    const enriched = sessions.map((s) => ({ ...s, sets: setsBySession.get(s.id) ?? [] }));
    const todays = enriched.find((s) => s.date === today()) ?? null;

    const [goal, manualWeight, manualSteps, hcConnected] = await Promise.all([
      getPref(STEP_GOAL_KEY),
      getPref(MANUAL_WEIGHT_KEY),
      getPref(MANUAL_STEPS_KEY),
      getPref(HC_CONNECTED_KEY),
    ]);

    const cap = await healthCapability();

    let source: HealthSource = 'manual';
    let todaySteps: number | null = manualSteps ? Number(manualSteps) : null;
    let latestWeight: number | null = manualWeight ? Number(manualWeight) : null;
    let hcWeekly: number[] | null = null;
    let lastSync: string | null = null;

    if (hcConnected === '1' && cap.available && (await hasHealthPermissions())) {
      source = 'health-connect';
      const [steps, weight, week] = await Promise.all([
        readTodaySteps(),
        readLatestWeightKg(),
        readWeeklySteps(),
      ]);
      if (steps != null) todaySteps = steps;
      if (weight != null) latestWeight = weight;
      hcWeekly = week ?? null;
      lastSync = new Date().toISOString();
    }

    // Merge HC weekly (if any) with persisted daily history so today's count
    // gets snapshotted and past days we've seen before don't drop to 0.
    const weekly = await buildWeeklyWithHistory(hcWeekly, todaySteps);

    set({
      sessions: enriched,
      todaySession: todays,
      todaySteps,
      latestWeight,
      weeklySteps: weekly,
      stepGoal: goal ? Number(goal) : 10000,
      source,
      hcAvailable: cap.available,
      hcReason: cap.reason,
      lastSync,
    });
  },

  async startOrGetTodaySession(type) {
    const existing = get().todaySession;
    if (existing && existing.sessionType === type) return existing.id;

    const id = generateId();
    const session: WorkoutSession = {
      id,
      sessionType: type,
      date: today(),
      sets: [],
      syncStatus: 'pending',
      createdAt: new Date().toISOString(),
    };
    await db.workoutSessions.add(session);
    set({ todaySession: { ...session, sets: [] } });
    await get().load();
    return id;
  },

  async addSet(sessionId, s) {
    const newSet: WorkoutSet = {
      ...s,
      id: generateId(),
      sessionId,
      createdAt: new Date().toISOString(),
    };
    await db.workoutSets.add(newSet);
    await get().load();
  },

  async updateSet(id, patch) {
    const existing = await db.workoutSets.get(id);
    if (!existing) return;
    const updated: WorkoutSet = { ...existing, ...patch, id };
    await db.workoutSets.put(updated);
    await get().load();
  },

  async deleteSet(id) {
    await db.workoutSets.delete(id);
    await get().load();
  },

  async deleteSession(id) {
    const sets = await db.workoutSets.where('sessionId').equals(id).toArray();
    await Promise.all(sets.map((s) => db.workoutSets.delete(s.id)));
    await db.workoutSessions.delete(id);
    await get().load();
  },

  async setStepGoal(goal) {
    await setPref(STEP_GOAL_KEY, String(goal));
    set({ stepGoal: goal });
  },

  async setManualWeight(kg) {
    if (kg == null) {
      await setPref(MANUAL_WEIGHT_KEY, '');
      set({ latestWeight: null });
    } else {
      await setPref(MANUAL_WEIGHT_KEY, String(kg));
      set({ latestWeight: kg });
    }
  },

  async setManualSteps(steps) {
    if (steps == null) {
      await setPref(MANUAL_STEPS_KEY, '');
      set({ todaySteps: null });
      return;
    }
    await setPref(MANUAL_STEPS_KEY, String(steps));
    // Snapshot today + rebuild weekly so the manual entry appears on the chart.
    const weekly = await buildWeeklyWithHistory(null, steps);
    set({ todaySteps: steps, weeklySteps: weekly });
  },

  async connectHealthConnect() {
    const cap = await healthCapability();
    if (!cap.available) {
      set({ hcAvailable: false, hcReason: cap.reason });
      return { ok: false, reason: cap.reason };
    }
    const result = await requestHealthPermissions();
    if (!result.ok) return result;
    await setPref(HC_CONNECTED_KEY, '1');
    set({ source: 'health-connect', hcAvailable: true });
    await get().syncHealthData();
    return { ok: true };
  },

  async syncHealthData() {
    set({ syncing: true });
    try {
      const [steps, weight, week] = await Promise.all([
        readTodaySteps(),
        readLatestWeightKg(),
        readWeeklySteps(),
      ]);
      const todaySteps = steps ?? get().todaySteps;
      const weekly = await buildWeeklyWithHistory(week ?? null, todaySteps);
      set({
        todaySteps,
        latestWeight: weight ?? get().latestWeight,
        weeklySteps: weekly,
        lastSync: new Date().toISOString(),
        syncing: false,
      });
    } catch {
      set({ syncing: false });
    }
  },

  async disconnectHealthConnect() {
    await setPref(HC_CONNECTED_KEY, '0');
    set({ source: 'manual', lastSync: null });
  },
}));
