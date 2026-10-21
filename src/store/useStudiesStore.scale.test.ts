import { describe, it, expect, beforeEach, vi } from 'vitest';

// v1.18.2 — a German 1–6 StudyDesk user saw their average as IB "x/7": NCC
// could only guess the scale from the numbers. The account's scale now wins.

const holder = vi.hoisted(() => ({ gradeScale: null as unknown }));
vi.mock('../lib/supabase', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve({ data: { grade_scale: holder.gradeScale }, error: null }),
        }),
      }),
    }),
    auth: { getSession: () => Promise.resolve({ data: { session: null } }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) },
  },
}));

const { useStudiesStore } = await import('./useStudiesStore');
const { useSessionStore } = await import('./useSessionStore');
const { db } = await import('../db/database');

const T0 = '2026-10-01T00:00:00Z';

async function seedGerman() {
  // Two subjects on the German scale (1 best): 1.5 and 2.5, one credit each.
  await db.courses.bulkPut([
    { id: 'c1', name: 'Mathe', credits: 1, importId: 'cloud', createdAt: T0 } as any,
    { id: 'c2', name: 'Physik', credits: 1, importId: 'cloud', createdAt: T0 } as any,
  ]);
  await db.grades.bulkPut([
    { id: 'g1', subjectId: 'c1', grade: 1.5, weight: 1, syncStatus: 'synced', createdAt: T0, updatedAt: T0 } as any,
    { id: 'g2', subjectId: 'c2', grade: 2.5, weight: 1, syncStatus: 'synced', createdAt: T0, updatedAt: T0 } as any,
  ]);
}

async function settle() {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
}

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
  localStorage.clear();
  holder.gradeScale = null;
  useSessionStore.setState({ user: { id: 'u1' } as any });
});

describe("NCC's GPA follows StudyDesk's scale (v1.18.2)", () => {
  it('without an account scale it still guesses (IB for grades up to 10)', async () => {
    await seedGerman();
    await useStudiesStore.getState().load();
    await settle();
    expect(useStudiesStore.getState().gradeScale).toMatchObject({ mode: 'ib', source: 'inferred' });
  });

  it("the account's German scale wins, and the average is the plain mean", async () => {
    await seedGerman();
    holder.gradeScale = { v: 1, mode: 'custom', custom: { min: 1, max: 6, passMark: 4, direction: 'down', name: '' } };
    await useStudiesStore.getState().load();
    await settle();
    const s = useStudiesStore.getState();
    expect(s.gradeScale).toMatchObject({ mode: 'custom', min: 1, max: 6, direction: 'down', source: 'account' });
    expect(s.gradeMode).toBe('custom');
    expect(s.currentImport?.calculatedGpa).toBe(2);
  });

  it('a later change in StudyDesk is picked up on the next load', async () => {
    await seedGerman();
    holder.gradeScale = { v: 1, mode: 'ib' };
    await useStudiesStore.getState().load();
    await settle();
    expect(useStudiesStore.getState().gradeScale).toMatchObject({ mode: 'ib', source: 'account' });
    holder.gradeScale = { v: 1, mode: 'custom', custom: { min: 4, max: 10, passMark: 5, direction: 'up', name: '' } };
    await useStudiesStore.getState().load();
    await settle();
    expect(useStudiesStore.getState().gradeScale).toMatchObject({ mode: 'custom', max: 10, direction: 'up' });
  });
});
