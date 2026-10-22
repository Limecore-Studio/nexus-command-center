import { describe, it, expect, beforeEach, vi } from 'vitest';

// v1.18.2 — NCC shows the GPA on StudyDesk's scale, read from
// user_preferences.grade_scale.

const holder = vi.hoisted(() => ({ gradeScale: null as unknown, fail: false }));
vi.mock('./supabase', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () =>
            Promise.resolve(
              holder.fail
                ? { data: null, error: { message: 'offline' } }
                : { data: { grade_scale: holder.gradeScale }, error: null },
            ),
        }),
      }),
    }),
  },
}));

const { parseAccountScale, gpaSuffix, meterValue, compareGpa, inferredScale, fetchAccountScale, readCachedAccountScale } =
  await import('./gradeScale');

const GERMAN = { v: 1, mode: 'custom', custom: { min: 1, max: 6, passMark: 4, direction: 'down', name: 'DE' } };
const FINNISH = { v: 1, mode: 'custom', custom: { min: 4, max: 10, passMark: 5, direction: 'up', name: '' } };

beforeEach(() => {
  holder.gradeScale = null;
  holder.fail = false;
  localStorage.clear();
});

describe('grade scale from the account', () => {
  it('reads StudyDesk custom scales, both directions', () => {
    expect(parseAccountScale(GERMAN)).toMatchObject({ mode: 'custom', min: 1, max: 6, direction: 'down', source: 'account' });
    expect(parseAccountScale(FINNISH)).toMatchObject({ mode: 'custom', min: 4, max: 10, direction: 'up' });
    expect(parseAccountScale({ mode: 'ib' })).toMatchObject({ mode: 'ib', max: 7 });
    expect(parseAccountScale({ mode: 'us' })).toMatchObject({ mode: 'us', max: 4 });
  });

  it('normalises like StudyDesk and refuses junk', () => {
    expect(parseAccountScale({ mode: 'custom', custom: { min: 10, max: 4 } })).toMatchObject({ min: 4, max: 10 });
    expect(parseAccountScale({ mode: 'custom', custom: { min: 5, max: 5 } })).toMatchObject({ min: 5, max: 6 });
    expect(parseAccountScale({ mode: 'custom' })).toBeNull();
    expect(parseAccountScale({ mode: 'nope' })).toBeNull();
    expect(parseAccountScale(null)).toBeNull();
  });

  it('suffix: /7, /20, /10; none for US points or a lower-is-better scale', () => {
    expect(gpaSuffix(inferredScale('ib'))).toBe('/7');
    expect(gpaSuffix(inferredScale('custom'))).toBe('/20');
    expect(gpaSuffix(parseAccountScale(FINNISH)!)).toBe('/10');
    expect(gpaSuffix(parseAccountScale(GERMAN)!)).toBe('');
    expect(gpaSuffix(inferredScale('us'))).toBe('');
  });

  it('the meter is fuller for a better grade on every scale', () => {
    const de = parseAccountScale(GERMAN)!;
    expect(meterValue(1, de)).toBe(6);
    expect(meterValue(6, de)).toBe(1);
    expect(meterValue(1.5, de)).toBeGreaterThan(meterValue(2.5, de));
    const fi = parseAccountScale(FINNISH)!;
    expect(meterValue(9, fi)).toBe(9);
    expect(compareGpa(1.5, 2.5, de)).toBe(1);
    expect(compareGpa(9, 8, fi)).toBe(1);
    expect(compareGpa(2, 2, de)).toBe(0);
  });

  it('fetch: caches per account, keeps the cache when offline, clears it when the account has none', async () => {
    holder.gradeScale = GERMAN;
    expect(await fetchAccountScale('u1')).toMatchObject({ direction: 'down' });
    expect(await readCachedAccountScale('u1')).toMatchObject({ direction: 'down' });
    expect(await readCachedAccountScale('u2')).toBeNull();

    holder.fail = true;
    expect(await fetchAccountScale('u1')).toBeUndefined();
    expect(await readCachedAccountScale('u1')).toMatchObject({ direction: 'down' });

    holder.fail = false;
    holder.gradeScale = null;
    expect(await fetchAccountScale('u1')).toBeNull();
    expect(await readCachedAccountScale('u1')).toBeNull();
    expect(await fetchAccountScale(null)).toBeNull();
  });
});
