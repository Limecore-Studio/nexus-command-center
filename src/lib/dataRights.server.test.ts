import { describe, it, expect, beforeEach, vi } from 'vitest';

// v1.22 (limecore#88) — "Export my data" covers everything the account holds
// on the server in all three apps, and the user's uploaded files.

type Req = { table: string; columns: string; eq: [string, unknown][]; order: string[]; range?: [number, number]; gt?: unknown; limit?: number };
const h = vi.hoisted(() => ({
  reqs: [] as Req[],
  rows: {} as Record<string, unknown[]>,
  failOn: new Set<string>(),
  files: {} as Record<string, { name: string; id: string | null; metadata?: unknown; created_at?: string }[]>,
}));

vi.mock('./supabase', () => ({
  readStoredSession: async () => null,
  supabase: {
    from(table: string) {
      const req: Req = { table, columns: '*', eq: [], order: [] };
      const q: any = {
        select(cols: string) { req.columns = cols; h.reqs.push(req); return q; },
        eq(col: string, v: unknown) { req.eq.push([col, v]); return q; },
        order(col: string) { req.order.push(col); return q; },
        limit(n: number) { req.limit = n; return q; },
        gt(_c: string, v: unknown) { req.gt = v; return q; },
        range(a: number, b: number) { req.range = [a, b]; return q; },
        then(resolve: (v: unknown) => void) {
          if (h.failOn.has(table)) return resolve({ data: null, error: { message: 'permission denied' }, count: null });
          // One page: everything on the first request, nothing after.
          const all = h.rows[table] ?? [];
          const first = req.gt === undefined && (!req.range || req.range[0] === 0);
          resolve({ data: first ? all : [], error: null, count: all.length });
        },
      };
      return q;
    },
    storage: {
      from(bucket: string) {
        return { list: async (prefix: string) => ({ data: h.files[`${bucket}/${prefix}`] ?? [], error: null }) };
      },
    },
  },
}));

const { serverOnlyData, serverFiles, SERVER_TABLES } = await import('./dataRights');

beforeEach(() => {
  h.reqs.length = 0;
  h.rows = {};
  h.failOn = new Set();
  h.files = {};
});

describe('server export (limecore#88)', () => {
  it('covers the other apps and the account tables, not just feedback and error reports', () => {
    const names = SERVER_TABLES.map((t) => t.table);
    for (const t of ['notebook_entries', 'timetable_entries', 'planned_sessions', 'body_metrics', 'workout_sets',
      'app_opens', 'audit_log', 'profiles', 'user_preferences', 'supporter_entitlements', 'kofi_alt_emails', 'feedback', 'client_errors']) {
      expect(names).toContain(t);
    }
    expect(names).not.toContain('ai_rate_limits');
  });

  it("reads each table as the user, by owner column; ranges tables without an id", async () => {
    h.rows = { body_metrics: [{ id: 'b1', user_id: 'u1' }], app_opens: [{ user_id: 'u1', app: 'ncc', opened_on: '2026-11-20' }] };
    const out = await serverOnlyData('u1');
    expect(out.body_metrics).toEqual([{ id: 'b1', user_id: 'u1' }]);
    expect(out.app_opens).toHaveLength(1);
    const req = (t: string) => h.reqs.find((r) => r.table === t)!;
    expect(req('body_metrics').eq).toEqual([['user_id', 'u1']]);
    expect(req('profiles').eq).toEqual([['id', 'u1']]);
    expect(req('audit_log').eq).toEqual([]);
    expect(req('app_opens').range).toEqual([0, 999]);
    expect(req('app_opens').order).toEqual(['opened_on', 'app']);
    expect(req('kofi_alt_emails').columns).not.toContain('code,');
  });

  it('records a table it cannot read instead of dropping it', async () => {
    h.failOn = new Set(['audit_log']);
    const out = await serverOnlyData('u1');
    expect(out.audit_log).toEqual({ error: 'permission denied' });
    expect(Array.isArray(out.subjects)).toBe(true);
  });

  it('lists uploaded files under the user folder, into sub-folders', async () => {
    h.files = {
      'notebook/u1': [{ name: 'page.png', id: 'f1', metadata: { size: 12, mimetype: 'image/png' }, created_at: '2026-11-01' }],
      'assignment-attachments/u1': [{ name: 'a1', id: null }],
      'assignment-attachments/u1/a1': [{ name: 'essay.pdf', id: 'f2', metadata: { size: 99 } }],
    };
    const files = await serverFiles('u1');
    expect(files.notebook).toEqual([{ path: 'u1/page.png', size: 12, createdAt: '2026-11-01', contentType: 'image/png' }]);
    expect(files['assignment-attachments']).toEqual([{ path: 'u1/a1/essay.pdf', size: 99, createdAt: null, contentType: null }]);
    expect(files.avatars).toEqual([]);
  });
});
