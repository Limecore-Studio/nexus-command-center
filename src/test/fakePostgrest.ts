// A small stand-in for supabase-js's query builder, faithful to the parts of
// PostgREST that paging depends on:
//   - a response is capped at `maxRows` whatever `limit` asked for, and the
//     truncated page comes back WITHOUT an error — the behaviour that made
//     every un-ranged pull in NCC silently lossy;
//   - `count: 'exact'` reports the full filtered total, not the page size;
//   - uuids order the way Postgres orders them (lowercase text order).
// Mirrors StudyDesk's `src/test/fakePostgrest.js`. Not a test file itself, and
// nothing in the app imports it, so it never reaches a bundle.

export interface FakeRequest {
  table: string;
  columns?: string;
  filters: [op: 'eq' | 'is', col: string, val: unknown][];
  order: { col: string; ascending: boolean } | null;
  limit: number | null;
  gt: [string, string] | null;
  count: string | null;
}

export interface FakeOptions {
  maxRows?: number;
  withCount?: boolean;
  ignoreGt?: boolean;
  /** Tables that do not exist: selects on them fail with 42P01. Any other
   *  table not in `tables` reads as empty. */
  missing?: string[];
  /** Unique constraints per table, beyond the `id` primary key, e.g.
   *  `{ habit_completions: [['habit_id', 'date']] }`. A write that would
   *  duplicate one fails with 23505, as Postgres does. */
  uniques?: Record<string, string[][]>;
  failWhen?: (req: FakeRequest, n: number) => { code: string; message: string } | null;
}

export function makeUuids(n: number): string[] {
  return Array.from({ length: n }, () => crypto.randomUUID());
}

export function fakeClient(tables: Record<string, any[]>, opts: FakeOptions = {}) {
  const { maxRows = 1000, withCount = true, ignoreGt = false, missing = [], uniques = {}, failWhen } = opts;
  const requests: FakeRequest[] = [];
  /** Every write, in order, for assertions. */
  const writes: { op: 'upsert' | 'update' | 'delete'; table: string; row?: any; filters: FakeRequest['filters'] }[] = [];

  const rowsOf = (table: string) => (tables[table] ??= []);
  const collides = (table: string, row: any, exceptId?: string) =>
    (uniques[table] ?? []).some((cols) =>
      rowsOf(table).some((r) => r.id !== exceptId && cols.every((c) => r[c] === row[c])),
    );
  const dup = (table: string) => ({
    data: null,
    error: { code: '23505', message: `duplicate key value violates unique constraint on ${table}` },
    count: null,
  });

  function writeBuilder(table: string, op: 'update' | 'delete', patch?: any) {
    const filters: FakeRequest['filters'] = [];
    // `.select()` after a write asks for the affected rows back, as PostgREST's
    // `Prefer: return=representation` does.
    let returning = false;
    const wb: any = {
      eq(col: string, val: unknown) {
        filters.push(['eq', col, val]);
        return wb;
      },
      select() {
        returning = true;
        return wb;
      },
      then(resolve: (v: any) => any, reject?: (e: any) => any) {
        return Promise.resolve()
          .then(() => {
            writes.push({ op, table, row: patch, filters });
            const hit = rowsOf(table).filter((r) => filters.every((f) => matches(r, f)));
            const data = returning ? hit.map((r) => ({ ...r, ...(op === 'update' ? patch : {}) })) : null;
            if (op === 'delete') {
              tables[table] = rowsOf(table).filter((r) => !hit.includes(r));
              return { data, error: null, count: null };
            }
            for (const r of hit) {
              if (collides(table, { ...r, ...patch }, r.id)) return dup(table);
            }
            for (const r of hit) Object.assign(r, patch);
            return { data, error: null, count: null };
          })
          .then(resolve, reject);
      },
    };
    return wb;
  }

  function from(table: string) {
    const req: FakeRequest = { table, filters: [], order: null, limit: null, gt: null, count: null };
    const builder: any = {
      // PostgREST upsert on the primary key: ON CONFLICT (id) DO UPDATE. Any
      // OTHER unique constraint still raises 23505.
      upsert(row: any) {
        return {
          then(resolve: (v: any) => any, reject?: (e: any) => any) {
            return Promise.resolve()
              .then(() => {
                writes.push({ op: 'upsert', table, row, filters: [] });
                const existing = rowsOf(table).find((r) => r.id === row.id);
                if (collides(table, row, row.id)) return dup(table);
                if (existing) Object.assign(existing, row);
                else rowsOf(table).push({ ...row });
                return { data: null, error: null, count: null };
              })
              .then(resolve, reject);
          },
        };
      },
      update(patch: any) {
        return writeBuilder(table, 'update', patch);
      },
      delete() {
        return writeBuilder(table, 'delete');
      },
      select(columns: string, o?: { count?: string }) {
        req.columns = columns;
        req.count = o?.count ?? null;
        return builder;
      },
      eq(col: string, val: unknown) {
        req.filters.push(['eq', col, val]);
        return builder;
      },
      is(col: string, val: unknown) {
        req.filters.push(['is', col, val]);
        return builder;
      },
      order(col: string, o?: { ascending?: boolean }) {
        req.order = { col, ascending: o?.ascending !== false };
        return builder;
      },
      limit(n: number) {
        req.limit = n;
        return builder;
      },
      gt(col: string, val: string) {
        req.gt = [col, val];
        return builder;
      },
      then(resolve: (v: any) => any, reject?: (e: any) => any) {
        return Promise.resolve().then(() => execute(req)).then(resolve, reject);
      },
    };
    return builder;
  }

  function matches(row: any, [op, col, val]: FakeRequest['filters'][number]) {
    // PostgREST `is.null` matches SQL NULL; an absent key reads as NULL too.
    if (op === 'is') return val === null ? row[col] == null : row[col] === val;
    return row[col] === val;
  }

  function execute(req: FakeRequest) {
    requests.push(req);
    const failure = failWhen?.(req, requests.length);
    if (failure) return { data: null, error: failure, count: null };
    if (missing.includes(req.table)) {
      return { data: null, error: { code: '42P01', message: `relation "${req.table}" does not exist` }, count: null };
    }

    let rows = (tables[req.table] ?? []).filter((r) => req.filters.every((f) => matches(r, f)));
    const total = rows.length;
    if (req.gt && !ignoreGt) {
      const [col, val] = req.gt;
      rows = rows.filter((r) => String(r[col]) > val);
    }
    if (req.order) {
      const { col, ascending } = req.order;
      rows = [...rows].sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : 1) * (ascending ? 1 : -1));
    }
    const take = Math.min(req.limit ?? Infinity, maxRows);
    return { data: rows.slice(0, take), error: null, count: req.count && withCount ? total : null };
  }

  return { from, requests, writes, tables };
}
