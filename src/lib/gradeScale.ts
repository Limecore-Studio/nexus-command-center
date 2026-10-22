// v1.18.2 — NCC shows the GPA on the scale StudyDesk uses.
//
// StudyDesk now writes its grade mode and custom scale to
// `user_preferences.grade_scale` (StudyDesk src/lib/gradeScaleCloud.js):
//
//   { v: 1, mode: 'ib' | 'us' | 'custom',
//     custom: { min, max, passMark, direction, name } | null, updatedAt }
//
// Before, NCC could only guess the scale from the numbers (inferGradeMode), so
// a German 1–6 average (1 best) was shown as IB "x/7". The account's scale now
// wins; the guess is only the fallback for an account StudyDesk hasn't synced
// a scale for yet. The last value read is cached per account, so the right
// scale also shows offline.

import { Preferences } from '@capacitor/preferences';
import { supabase } from './supabase';
import type { GradeMode } from '../utils/gpa';

export type ScaleDirection = 'up' | 'down';

export interface GradeScale {
  mode: GradeMode;
  min: number;
  max: number;
  passMark: number;
  /** 'down' = lower is better (German, Czech 1–6). */
  direction: ScaleDirection;
  /** The user's own name for the scale; '' when none. */
  name: string;
  /** Where it came from: StudyDesk's account setting, or NCC's guess. */
  source: 'account' | 'inferred';
}

/** Largest magnitude grades.grade can hold (numeric(7,2)), as in StudyDesk. */
const MAX_GRADE = 99999;

// 'us' is shown in 4.0 points (calculateGPA converts percentages), so its
// display bounds are 0–4, not the 0–100 the grades are entered in.
const BUILTIN: Record<'ib' | 'us', Omit<GradeScale, 'source'>> = {
  ib: { mode: 'ib', min: 1, max: 7, passMark: 4, direction: 'up', name: '' },
  us: { mode: 'us', min: 0, max: 4, passMark: 1, direction: 'up', name: '' },
};

/** The scale NCC guesses when the account has none (see inferGradeMode):
 *  'custom' is only ever inferred for a 0–20 scale. */
export function inferredScale(mode: GradeMode): GradeScale {
  if (mode === 'custom') return { mode, min: 0, max: 20, passMark: 10, direction: 'up', name: '', source: 'inferred' };
  return { ...BUILTIN[mode], source: 'inferred' };
}

function num(v: unknown, fallback: number): number {
  const n = typeof v === 'string' ? parseFloat(v) : (v as number);
  return Number.isFinite(n) ? n : fallback;
}

/** Same rules as StudyDesk's normalizeScale, so both apps read one value the
 *  same way. Null when the stored value is unusable. */
export function parseAccountScale(raw: unknown): GradeScale | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { mode?: unknown; custom?: Record<string, unknown> | null };
  if (r.mode === 'ib' || r.mode === 'us') return { ...BUILTIN[r.mode], source: 'account' };
  if (r.mode !== 'custom' || !r.custom || typeof r.custom !== 'object') return null;
  const c = r.custom;
  const clamp = (n: number) => Math.max(-MAX_GRADE, Math.min(MAX_GRADE, n));
  let min = clamp(num(c.min, 4));
  let max = clamp(num(c.max, 10));
  if (min > max) [min, max] = [max, min];
  if (min === max) max = min + 1;
  const passMark = Math.min(max, Math.max(min, num(c.passMark, 5)));
  const direction: ScaleDirection = c.direction === 'down' ? 'down' : 'up';
  const name = typeof c.name === 'string' ? c.name.trim().slice(0, 24) : '';
  return { mode: 'custom', min, max, passMark, direction, name, source: 'account' };
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

/** What follows the number on the dashboard: "/7", "/20", "/10". Nothing for
 *  US points, and nothing for a lower-is-better scale, where "1.8/6" would
 *  read as a poor result. */
export function gpaSuffix(scale: GradeScale): string {
  if (scale.mode === 'us') return '';
  if (scale.direction === 'down') return '';
  return '/' + fmt(scale.max);
}

/** Meter reading for a GPA on this scale: fuller is better on every scale. */
export function meterValue(gpa: number, scale: GradeScale): number {
  const v = scale.direction === 'down' ? scale.max + scale.min - gpa : gpa;
  return Math.max(0, Math.min(scale.max, v));
}

/** -1 / 0 / 1: is `a` better than `b` on this scale? */
export function compareGpa(a: number, b: number, scale: GradeScale): number {
  if (a === b) return 0;
  const better = scale.direction === 'down' ? a < b : a > b;
  return better ? 1 : -1;
}

// ── Account value, cached per account ───────────────────────────────────

const cacheKey = (userId: string) => `studies.gradeScale.account.${userId}`;

// Preferences with the localStorage fallback useStudiesStore uses for its
// own keys (the web build and tests have no native plugin).
async function cacheGet(key: string): Promise<string | null> {
  try {
    return (await Preferences.get({ key })).value;
  } catch {
    try { return localStorage.getItem(key); } catch { return null; }
  }
}
async function cacheSet(key: string, value: string): Promise<void> {
  try {
    await Preferences.set({ key, value });
  } catch {
    try { localStorage.setItem(key, value); } catch { /* offline convenience only */ }
  }
}
async function cacheRemove(key: string): Promise<void> {
  try {
    await Preferences.remove({ key });
  } catch {
    try { localStorage.removeItem(key); } catch { /* offline convenience only */ }
  }
}

export async function readCachedAccountScale(userId: string | null): Promise<GradeScale | null> {
  if (!userId) return null;
  try {
    const value = await cacheGet(cacheKey(userId));
    return value ? parseAccountScale(JSON.parse(value)) : null;
  } catch {
    return null;
  }
}

/** Reads the account's scale. `undefined` when the read failed (keep what we
 *  have), `null` when the account has none (StudyDesk hasn't synced one). */
export async function fetchAccountScale(userId: string | null): Promise<GradeScale | null | undefined> {
  if (!userId) return null;
  try {
    const { data, error } = await supabase
      .from('user_preferences')
      .select('grade_scale')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) return undefined;
    const raw = (data as { grade_scale?: unknown } | null)?.grade_scale ?? null;
    const scale = parseAccountScale(raw);
    if (scale) await cacheSet(cacheKey(userId), JSON.stringify(raw));
    else await cacheRemove(cacheKey(userId));
    return scale;
  } catch {
    return undefined;
  }
}
