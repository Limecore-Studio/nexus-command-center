import { describe, it, expect, beforeEach, vi } from 'vitest';

// v1.22 (NCC#278) — NCC reads StudyDesk's exams and assignments for the
// Weekly Review, and only reads them.

type Call = { table: string; method: string; args: unknown[] };
const h = vi.hoisted(() => ({ calls: [] as Call[], rows: {} as Record<string, unknown[]>, fail: false }));

vi.mock('./supabase', () => ({
  supabase: {
    from(table: string) {
      const q: any = {};
      for (const method of ['select', 'eq', 'is', 'gte', 'lte', 'order', 'limit', 'insert', 'update', 'upsert', 'delete']) {
        q[method] = (...args: unknown[]) => {
          h.calls.push({ table, method, args });
          return q;
        };
      }
      q.then = (resolve: (v: unknown) => void) =>
        resolve(h.fail ? { data: null, error: { message: 'offline' } } : { data: h.rows[table] ?? [], error: null });
      return q;
    },
  },
}));

const { fetchStudyDeadlines, daysUntil } = await import('./studyDeadlines');

beforeEach(() => {
  h.calls.length = 0;
  h.rows = {};
  h.fail = false;
});

describe('fetchStudyDeadlines', () => {
  it('reads open, live rows of this user in the range, and writes nothing', async () => {
    h.rows = {
      exams: [{ id: 'e1', subject_id: 's1', title: 'Final', due_date: '2026-11-27' }],
      assignments: [{ id: 'a1', subject_id: 's2', title: 'Essay', due_date: '2026-11-23' }],
    };
    const out = await fetchStudyDeadlines('u1', '2026-11-20', '2026-11-29');
    expect(out.map((d) => `${d.kind}:${d.id}`)).toEqual(['assignment:a1', 'exam:e1']);
    for (const table of ['exams', 'assignments']) {
      const of = h.calls.filter((c) => c.table === table);
      expect(of.some((c) => ['insert', 'update', 'upsert', 'delete'].includes(c.method))).toBe(false);
      expect(of).toEqual(expect.arrayContaining([
        { table, method: 'eq', args: ['user_id', 'u1'] },
        { table, method: 'eq', args: ['done', false] },
        { table, method: 'is', args: ['deleted_at', null] },
        { table, method: 'gte', args: ['due_date', '2026-11-20'] },
        { table, method: 'lte', args: ['due_date', '2026-11-29'] },
      ]));
    }
  });

  it('offline or on an error: none, without throwing', async () => {
    h.fail = true;
    await expect(fetchStudyDeadlines('u1', '2026-11-20', '2026-11-29')).resolves.toEqual([]);
  });
});

describe('daysUntil', () => {
  it('counts whole local days', () => {
    expect(daysUntil('2026-11-20', '2026-11-20')).toBe(0);
    expect(daysUntil('2026-11-21', '2026-11-20')).toBe(1);
    expect(daysUntil('2026-12-01', '2026-11-20')).toBe(11);
  });
});
