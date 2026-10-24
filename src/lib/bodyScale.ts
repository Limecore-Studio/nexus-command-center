// v1.19 (NCC#214) — what NCC shows of LimeLog's body data (limelog#104):
// the latest weight, the height that applied on that day, BMI, and the latest
// smart-scale readings. BMI follows LimeLog's rule (its src/lib/bodyScale.ts,
// heightOn / latestBmi), so both apps show the same number: the latest weight
// over the height measured on or before that weight's day.

import type { BodyMetric } from '../types/fitness';

export type ScaleKey =
  | 'bodyFatPct' | 'waterPct' | 'proteinPct' | 'bmrKcal'
  | 'visceralFat' | 'boneMassKg' | 'muscleMassKg' | 'bodyAge';

/** In LimeLog's order, with the i18n key under life.body and the unit. */
export const SCALE_METRICS: readonly { key: ScaleKey; label: string; unit: string }[] = [
  { key: 'bodyFatPct', label: 'bodyFat', unit: '%' },
  { key: 'waterPct', label: 'water', unit: '%' },
  { key: 'proteinPct', label: 'protein', unit: '%' },
  { key: 'bmrKcal', label: 'bmr', unit: ' kcal' },
  { key: 'visceralFat', label: 'visceral', unit: '' },
  { key: 'boneMassKg', label: 'bone', unit: ' kg' },
  { key: 'muscleMassKg', label: 'muscle', unit: ' kg' },
  { key: 'bodyAge', label: 'bodyAge', unit: '' },
];

// v1.19 (NCC#214) — LimeLog's height and smart-scale columns (limelog#104).
// numeric columns arrive as strings; absent on a row LimeLog never filled.
const SCALE_COLUMNS = {
  heightCm: 'height_cm', bodyFatPct: 'body_fat_pct', waterPct: 'water_pct', proteinPct: 'protein_pct',
  bmrKcal: 'bmr_kcal', visceralFat: 'visceral_fat', boneMassKg: 'bone_mass_kg',
  muscleMassKg: 'muscle_mass_kg', bodyAge: 'body_age',
} as const;

export function scaleFields(r: Record<string, unknown>): Partial<BodyMetric> {
  const out: Partial<Record<keyof typeof SCALE_COLUMNS, number>> = {};
  for (const [key, col] of Object.entries(SCALE_COLUMNS) as [keyof typeof SCALE_COLUMNS, string][]) {
    const n = r[col] != null ? Number(r[col]) : NaN;
    if (Number.isFinite(n)) out[key] = n;
  }
  return out;
}

const byDate = (a: BodyMetric, b: BodyMetric) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);

/** The latest row (by its date) that has this field. */
function latestWith<K extends keyof BodyMetric>(metrics: BodyMetric[], key: K): BodyMetric | null {
  let at: BodyMetric | null = null;
  for (const m of metrics) if (m[key] != null && (!at || byDate(m, at) > 0)) at = m;
  return at;
}

/** The height that applied on `date`: the latest measured on or before it,
 *  else the first measured after. */
export function heightOn(metrics: BodyMetric[], date: string): number | null {
  const hs = metrics.filter((m) => m.heightCm != null).sort(byDate);
  if (!hs.length) return null;
  let at: number | null = null;
  for (const h of hs) if (h.date <= date) at = h.heightCm!;
  return at ?? hs[0].heightCm!;
}

/** BMI from the latest weight and the height that applied on its day. */
export function latestBmi(metrics: BodyMetric[]): { bmi: number; date: string } | null {
  const w = latestWith(metrics, 'weightKg');
  if (!w) return null;
  const h = heightOn(metrics, w.date);
  if (!h) return null;
  const m = h / 100;
  return { bmi: Math.round((w.weightKg! / (m * m)) * 10) / 10, date: w.date };
}

export interface BodySummary {
  weight: { kg: number; date: string } | null;
  height: { cm: number; date: string } | null;
  bmi: number | null;
  scale: { key: ScaleKey; label: string; text: string }[];
}

const round1 = (n: number) => String(Math.round(n * 10) / 10);

/** Null when there is no body data at all. */
export function bodySummary(metrics: BodyMetric[]): BodySummary | null {
  const w = latestWith(metrics, 'weightKg');
  const h = latestWith(metrics, 'heightCm');
  const scale = SCALE_METRICS.flatMap((s) => {
    const row = latestWith(metrics, s.key);
    if (!row) return [];
    const v = row[s.key]!;
    return [{ key: s.key, label: s.label, text: (s.unit === ' kcal' ? String(Math.round(v)) : round1(v)) + s.unit }];
  });
  if (!w && !h && !scale.length) return null;
  return {
    weight: w ? { kg: w.weightKg!, date: w.date } : null,
    height: h ? { cm: h.heightCm!, date: h.date } : null,
    bmi: latestBmi(metrics)?.bmi ?? null,
    scale,
  };
}
