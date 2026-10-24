import { describe, expect, it } from 'vitest';

// v1.19 (NCC#214) — LimeLog's height and smart-scale columns, and BMI by
// LimeLog's rule.
import { bodySummary, heightOn, latestBmi, scaleFields } from './bodyScale';
import type { BodyMetric } from '../types/fitness';

const row = (date: string, extra: Partial<BodyMetric>): BodyMetric =>
  ({ id: date, date, syncStatus: 'synced', createdAt: '', updatedAt: '', ...extra });

describe('reading the new body_metrics columns', () => {
  it('maps the nine columns, numeric strings included', () => {
    expect(scaleFields({ height_cm: '178.5', body_fat_pct: '18.2', bmr_kcal: 1650, body_age: '27', water_pct: null }))
      .toEqual({ heightCm: 178.5, bodyFatPct: 18.2, bmrKcal: 1650, bodyAge: 27 });
  });
  it('a row from before the migration has none of them', () => {
    expect(scaleFields({ weight_kg: '72' })).toEqual({});
  });
});

describe('BMI follows LimeLog', () => {
  const growing = [
    row('2026-01-10', { heightCm: 170 }),
    row('2026-06-01', { heightCm: 175 }),
    row('2026-03-01', { weightKg: 60 }),
  ];
  it('uses the height measured on or before the weight day, not the latest', () => {
    expect(heightOn(growing, '2026-03-01')).toBe(170);
    expect(latestBmi(growing)).toEqual({ bmi: 20.8, date: '2026-03-01' });
  });
  it('a height measured only after the weight still gives a BMI', () => {
    expect(latestBmi([row('2026-01-01', { weightKg: 70 }), row('2026-02-01', { heightCm: 180 })])!.bmi).toBe(21.6);
  });
  it('no height, no BMI', () => {
    expect(latestBmi([row('2026-01-01', { weightKg: 70 })])).toBeNull();
  });
});

describe('the summary NCC shows', () => {
  it('latest value of each reading, in LimeLog order', () => {
    const s = bodySummary([
      row('2026-10-01', { weightKg: 80, bodyFatPct: 20, bmrKcal: 1700.4 }),
      row('2026-10-20', { weightKg: 79.46, muscleMassKg: 35.26, heightCm: 180 }),
      row('2026-10-10', { bodyFatPct: 19.5 }),
    ])!;
    expect(s.weight).toEqual({ kg: 79.46, date: '2026-10-20' });
    expect(s.height).toEqual({ cm: 180, date: '2026-10-20' });
    expect(s.bmi).toBe(24.5);
    expect(s.scale.map((x) => [x.label, x.text])).toEqual([['bodyFat', '19.5%'], ['bmr', '1700 kcal'], ['muscle', '35.3 kg']]);
  });
  it('nothing logged is no summary', () => {
    expect(bodySummary([])).toBeNull();
    expect(bodySummary([row('2026-10-01', { waistCm: 80 })])).toBeNull();
  });
});
