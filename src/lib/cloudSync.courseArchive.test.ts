import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeClient } from '../test/fakePostgrest';
import { legacyIdToUuid } from '../utils/uuid';
import type { Course } from '../types/studies';

// v1.18.1 (NCC#180) — a course edit in NCC must not restate the archive, and
// an archive change made in NCC is decided on its own edit stamp. Through the
// REAL studies store, sync queue and push handler; only the Supabase client is
// a stand-in.

const holder = vi.hoisted(() => ({ client: null as any }));
vi.mock('./supabase', () => ({
  get supabase() {
    return holder.client;
  },
}));

const { pushQueue, adoptLocalData } = await import('./cloudSync');
const { hydrateStudiesTables } = await import('./cloudSyncHydrate');
const { enqueue, listPending } = await import('../db/syncQueue');
const { db } = await import('../db/database');
const { useStudiesStore } = await import('../store/useStudiesStore');

const USER = 'user-1';
const ARCHIVED = '2026-10-01T09:00:00.000Z';
const LONG_AGO = '2026-01-01T00:00:00.000Z';

type Write = { table: string; op: 'update' | 'upsert'; row: any; opts?: any; eq?: [string, unknown] };
type Refusal = { code?: string; message: string } | null;
const t = (iso: string | null | undefined) => (iso ? new Date(iso).getTime() : -Infinity);
const plus1ms = (iso: string) => new Date(t(iso) + 1).toISOString();

/**
 * A `subjects` table with the server's rules, enough for these tests:
 *  - set_updated_at(): a write whose updated_at is older than the row's is
 *    declined WHOLE (the row keeps every column);
 *  - subjects_archive_edit_stamp (20261016): a write sending archived_edited_at
 *    is decided on it, and an archive-only one moves updated_at by 1 ms; a
 *    legacy archive change rides on the write's own updated_at; an insert born
 *    archived is stamped from its updated_at;
 *  - zz_skip_noop_update / a declined update: 0 rows.
 * `refuse` can turn a write down the way PostgREST does, before it applies.
 */
function lwwClient(rows: any[] = [], refuse: (w: Write) => Refusal = () => null) {
  const base = fakeClient({});
  const writes: Write[] = [];
  const find = (id: unknown) => rows.find((r) => r.id === id);

  function applyUpdate(old: any, patch: any): boolean {
    const next = { ...old, ...patch };
    if ('archived_edited_at' in patch) {
      if (old.archived_edited_at && t(patch.archived_edited_at) < t(old.archived_edited_at)) return false;
      const onlyArchive = Object.keys(patch).every((k) => k === 'archived_at' || k === 'archived_edited_at');
      if (onlyArchive) {
        if ((old.archived_at ?? null) === (patch.archived_at ?? null)) return false;
        next.updated_at = plus1ms(old.updated_at);
      }
    } else if ('updated_at' in patch && t(patch.updated_at) < t(old.updated_at)) {
      return false; // declined whole
    } else if ('archived_at' in patch && (old.archived_at ?? null) !== (patch.archived_at ?? null)) {
      const incoming = t(patch.updated_at);
      if (old.archived_edited_at && incoming < t(old.archived_edited_at)) {
        next.archived_at = old.archived_at;
      } else {
        next.archived_edited_at = patch.updated_at;
      }
    }
    Object.assign(old, next);
    return true;
  }

  const result = (w: Write, run: () => any[] | null, returning: () => boolean) =>
    Promise.resolve().then(() => {
      writes.push(w);
      const error = refuse(w);
      if (error) return { data: null, error };
      const hit = run();
      return { data: returning() ? hit : null, error: null };
    });

  return {
    writes,
    rows,
    from(table: string) {
      const b = base.from(table);
      b.upsert = (row: any, opts?: any) => {
        const w: Write = { table, op: 'upsert', row, opts };
        return result(w, () => {
          const old = find(row.id);
          if (!old) {
            const born = { ...row };
            if (born.archived_at && !born.archived_edited_at) born.archived_edited_at = born.updated_at;
            rows.push(born);
            return [born];
          }
          if (opts?.ignoreDuplicates) return [];
          return applyUpdate(old, row) ? [old] : [];
        }, () => false);
      };
      b.update = (patch: any) => ({
        eq: (col: string, val: unknown) => {
          const w: Write = { table, op: 'update', row: patch, eq: [col, val] };
          let returning = false;
          const run = () => rows.filter((r) => r[col] === val && applyUpdate(r, patch));
          const p: any = {
            select: () => {
              returning = true;
              return p;
            },
            then: (res: any, rej: any) => result(w, run, () => returning).then(res, rej),
          };
          return p;
        },
      });
      return b;
    },
  };
}

const MISSING_COLUMN = {
  code: 'PGRST204',
  message: "Could not find the 'archived_edited_at' column of 'subjects' in the schema cache",
};
const stampedRefused = (w: Write): Refusal => ('archived_edited_at' in w.row ? MISSING_COLUMN : null);

function course(over: Partial<Course> = {}): Course {
  return {
    id: crypto.randomUUID(),
    importId: 'cloud',
    name: 'Mathematics',
    credits: 5,
    semester: 'Fall',
    createdAt: '2026-09-01T00:00:00.000Z',
    ...over,
  };
}

/** The server copy of `c`, as of `updated_at`. */
function serverRow(c: Course, over: Record<string, unknown> = {}) {
  return {
    id: c.id,
    user_id: USER,
    name: c.name,
    credits: c.credits,
    semester: c.semester ?? null,
    color: null,
    archived_at: null,
    archived_edited_at: null,
    updated_at: LONG_AGO,
    ...over,
  };
}

const subjectWrites = () => (holder.client.writes as Write[]).filter((w) => w.table === 'subjects');

beforeEach(async () => {
  holder.client = lwwClient();
  await Promise.all(db.tables.map((t) => t.clear()));
  useStudiesStore.setState({ courses: [], grades: [], currentImport: null });
});

describe('course push: archived_at only for an archive change made in NCC (NCC#180)', () => {
  it('a rename of a course this copy holds as archived does not send archived_at', async () => {
    // The local copy is stale: StudyDesk restored the course since the last pull.
    const c = course({ archivedAt: ARCHIVED });
    holder.client = lwwClient([serverRow(c)]);
    await db.courses.put(c);
    await useStudiesStore.getState().updateCourse(c.id, { name: 'Calculus' });
    const r = await pushQueue(USER);
    expect(r.failed).toBe(0);
    const [w, ...rest] = subjectWrites();
    expect(rest).toHaveLength(0);
    expect(w.op).toBe('upsert');
    expect(w.row).toMatchObject({ id: c.id, name: 'Calculus', credits: 5 });
    expect(w.row).not.toHaveProperty('archived_at');
    expect(w.row).not.toHaveProperty('archived_edited_at');
    expect(holder.client.rows[0]).toMatchObject({ name: 'Calculus', archived_at: null });
  });

  it('an edit of an active course does not send archived_at: null (no un-archive)', async () => {
    const c = course();
    holder.client = lwwClient([serverRow(c, { archived_at: ARCHIVED, archived_edited_at: ARCHIVED })]);
    await db.courses.put(c);
    await useStudiesStore.getState().updateCourse(c.id, { credits: 6 });
    await pushQueue(USER);
    const [w] = subjectWrites();
    expect(w.row).toMatchObject({ credits: 6 });
    expect(w.row).not.toHaveProperty('archived_at');
    expect(holder.client.rows[0]).toMatchObject({ credits: 6, archived_at: ARCHIVED });
  });

  it('a new course is inserted without archived_at (column default: active)', async () => {
    await useStudiesStore.getState().addCourse({ name: 'Physics', credits: 3 });
    await pushQueue(USER);
    const ws = subjectWrites();
    expect(ws).toHaveLength(1);
    expect(ws[0].op).toBe('upsert');
    expect(ws[0].row.name).toBe('Physics');
    expect(ws[0].row).not.toHaveProperty('archived_at');
  });

  it('an item queued by an older build (whole course, no marker) does not send archived_at', async () => {
    const c = course({ archivedAt: ARCHIVED });
    await enqueue('course', c.id, 'update', c);
    await pushQueue(USER);
    const [w] = subjectWrites();
    expect(w.row).not.toHaveProperty('archived_at');
  });

  it('a legacy local id still reaches the server as its uuid', async () => {
    const c = course({ id: 'legacy-course-1' });
    await db.courses.put(c);
    await useStudiesStore.getState().updateCourse(c.id, { name: 'Algebra' });
    await pushQueue(USER);
    expect(subjectWrites()[0].row.id).toBe(legacyIdToUuid('legacy-course-1'));
  });
});

describe('adoption insert of an archived course', () => {
  it('lands archived when the server has never seen the course', async () => {
    const c = course({ archivedAt: ARCHIVED });
    await db.courses.put(c);
    await adoptLocalData(USER);
    expect((await pushQueue(USER)).failed).toBe(0);
    const ws = subjectWrites();
    expect(ws).toHaveLength(2);
    expect(ws[0]).toMatchObject({ op: 'upsert', opts: { onConflict: 'id', ignoreDuplicates: true } });
    expect(ws[0].row).toMatchObject({ archived_at: ARCHIVED });
    expect(ws[0].row).not.toHaveProperty('archived_edited_at');
    expect(ws[1].row).not.toHaveProperty('archived_at');
    expect(holder.client.rows).toHaveLength(1);
    expect(holder.client.rows[0]).toMatchObject({ id: c.id, archived_at: ARCHIVED });
  });

  it('leaves the archive of an existing server row alone (restored in StudyDesk since)', async () => {
    const c = course({ archivedAt: ARCHIVED });
    holder.client = lwwClient([serverRow(c, { archived_edited_at: '2026-10-02T00:00:00.000Z' })]);
    await db.courses.put(c);
    await adoptLocalData(USER);
    expect((await pushQueue(USER)).failed).toBe(0);
    expect(holder.client.rows).toHaveLength(1);
    expect(holder.client.rows[0].archived_at).toBeNull();
  });

  it('an active course is still adopted with one plain upsert', async () => {
    await db.courses.put(course());
    await adoptLocalData(USER);
    await pushQueue(USER);
    const ws = subjectWrites();
    expect(ws).toHaveLength(1);
    expect(ws[0].opts).toBeUndefined();
    expect(ws[0].row).not.toHaveProperty('archived_at');
  });
});

describe('archive change made in NCC', () => {
  it('a restore writes only archived_at + archived_edited_at (edit time), no updated_at', async () => {
    const c = course({ archivedAt: ARCHIVED });
    holder.client = lwwClient([serverRow(c, { archived_at: ARCHIVED, archived_edited_at: ARCHIVED })]);
    await db.courses.put(c);
    const before = Date.now();
    await useStudiesStore.getState().updateCourse(c.id, { archivedAt: undefined });
    expect((await db.courses.get(c.id))?.archivedAt).toBeUndefined();
    // The marker lives in the queue only, never in Dexie.
    expect(await db.courses.get(c.id)).not.toHaveProperty('archiveEditedAt');
    expect((await pushQueue(USER)).failed).toBe(0);
    const ws = subjectWrites();
    expect(ws).toHaveLength(1);
    expect(ws[0].op).toBe('update');
    expect(ws[0].eq).toEqual(['id', c.id]);
    expect(Object.keys(ws[0].row).sort()).toEqual(['archived_at', 'archived_edited_at']);
    expect(ws[0].row.archived_at).toBeNull();
    expect(t(ws[0].row.archived_edited_at)).toBeGreaterThanOrEqual(before);
    expect(holder.client.rows[0]).toMatchObject({ archived_at: null, updated_at: plus1ms(LONG_AGO) });
  });

  it('a restore older than the archive on the server is declined, and that is final', async () => {
    const c = course({ archivedAt: ARCHIVED });
    const FUTURE = new Date(Date.now() + 3_600_000).toISOString();
    holder.client = lwwClient([serverRow(c, { archived_at: ARCHIVED, archived_edited_at: FUTURE })]);
    await db.courses.put(c);
    await useStudiesStore.getState().updateCourse(c.id, { archivedAt: undefined });
    expect((await pushQueue(USER)).failed).toBe(0);
    expect(await listPending()).toHaveLength(0);
    expect(holder.client.rows[0].archived_at).toBe(ARCHIVED);
  });

  it('falls back to the pre-1.18.1 archive write when archived_edited_at does not exist', async () => {
    const c = course({ archivedAt: ARCHIVED });
    holder.client = lwwClient([serverRow(c, { archived_at: ARCHIVED })], stampedRefused);
    await db.courses.put(c);
    await useStudiesStore.getState().updateCourse(c.id, { archivedAt: undefined });
    expect((await pushQueue(USER)).failed).toBe(0);
    const ws = subjectWrites();
    expect(ws).toHaveLength(2);
    expect(ws[1].op).toBe('update');
    expect(Object.keys(ws[1].row).sort()).toEqual(['archived_at', 'updated_at']);
    expect(holder.client.rows[0].archived_at).toBeNull();
  });

  it('also accepts the Postgres form of the missing column (42703)', async () => {
    const c = course({ archivedAt: ARCHIVED });
    holder.client = lwwClient([serverRow(c, { archived_at: ARCHIVED })], (w) =>
      'archived_edited_at' in w.row
        ? { code: '42703', message: 'column "archived_edited_at" of relation "subjects" does not exist' }
        : null,
    );
    await db.courses.put(c);
    await useStudiesStore.getState().updateCourse(c.id, { archivedAt: undefined });
    expect((await pushQueue(USER)).failed).toBe(0);
    expect(subjectWrites()).toHaveLength(2);
  });

  it('any other refusal is not swallowed, and there is no blind retry', async () => {
    holder.client = lwwClient([], () => ({ code: '42501', message: 'permission denied for table subjects' }));
    const c = course({ archivedAt: ARCHIVED });
    await db.courses.put(c);
    await useStudiesStore.getState().updateCourse(c.id, { archivedAt: undefined });
    expect((await pushQueue(USER)).failed).toBe(1);
    expect(subjectWrites()).toHaveLength(1);
  });

  it('content + archive in one edit: content upsert, then the archive on its own stamp', async () => {
    const c = course();
    holder.client = lwwClient([serverRow(c)]);
    await db.courses.put(c);
    await useStudiesStore.getState().updateCourse(c.id, { name: 'Old course', archivedAt: ARCHIVED });
    expect((await pushQueue(USER)).failed).toBe(0);
    const ws = subjectWrites();
    expect(ws).toHaveLength(2);
    expect(ws[0].op).toBe('upsert');
    expect(ws[0].row).toMatchObject({ name: 'Old course' });
    expect(ws[0].row).not.toHaveProperty('archived_at');
    expect(ws[1].op).toBe('update');
    expect(Object.keys(ws[1].row).sort()).toEqual(['archived_at', 'archived_edited_at']);
    expect(holder.client.rows[0]).toMatchObject({ name: 'Old course', archived_at: ARCHIVED });
  });

  it('…and when its content is stale, the content is declined but the archive still lands', async () => {
    // StudyDesk renamed the course after this edit was made (row stamped newer).
    const c = course();
    const NEWER = new Date(Date.now() + 3_600_000).toISOString();
    holder.client = lwwClient([serverRow(c, { name: 'Renamed in StudyDesk', updated_at: NEWER })]);
    await db.courses.put(c);
    await useStudiesStore.getState().updateCourse(c.id, { name: 'Old course', archivedAt: ARCHIVED });
    expect((await pushQueue(USER)).failed).toBe(0);
    expect(holder.client.rows[0]).toMatchObject({ name: 'Renamed in StudyDesk', archived_at: ARCHIVED });
  });

  it('…and without the column, the archive goes the pre-1.18.1 way after the content', async () => {
    const c = course();
    holder.client = lwwClient([serverRow(c)], stampedRefused);
    await db.courses.put(c);
    await useStudiesStore.getState().updateCourse(c.id, { name: 'Old course', archivedAt: ARCHIVED });
    expect((await pushQueue(USER)).failed).toBe(0);
    const ws = subjectWrites();
    expect(ws.map((w) => w.op)).toEqual(['upsert', 'update', 'update']);
    expect(Object.keys(ws[2].row).sort()).toEqual(['archived_at', 'updated_at']);
    expect(holder.client.rows[0]).toMatchObject({ name: 'Old course', archived_at: ARCHIVED });
  });

  it('an archive of a course whose insert failed stays queued and lands after the insert', async () => {
    let down = true;
    holder.client = lwwClient([], (w) => (down && w.op === 'upsert' ? { message: 'fetch failed' } : null));
    await useStudiesStore.getState().addCourse({ name: 'Physics', credits: 3 });
    const id = useStudiesStore.getState().courses[0].id;
    await useStudiesStore.getState().updateCourse(id, { archivedAt: ARCHIVED });
    const first = await pushQueue(USER);
    expect(first.failed).toBe(2);
    expect(await listPending()).toHaveLength(2);
    down = false;
    // Same-millisecond items may drain in either order; a drain at most
    // defers the archive by one more run.
    for (let i = 0; i < 3 && (await listPending()).length > 0; i++) await pushQueue(USER);
    expect(await listPending()).toHaveLength(0);
    expect(holder.client.rows).toHaveLength(1);
    expect(holder.client.rows[0]).toMatchObject({ id, name: 'Physics', archived_at: ARCHIVED });
  });
});

describe('hydrate: archived_edited_at from the server is harmless', () => {
  it('maps archived_at and ignores archived_edited_at', async () => {
    const id = crypto.randomUUID();
    holder.client = fakeClient({
      subjects: [
        {
          id,
          user_id: USER,
          name: 'Mathematics',
          credits: 5,
          semester: 'Fall',
          color: null,
          archived_at: ARCHIVED,
          archived_edited_at: ARCHIVED,
          deleted_at: null,
          created_at: '2026-09-01T00:00:00.000Z',
          updated_at: ARCHIVED,
        },
      ],
    });
    const r = await hydrateStudiesTables(USER);
    expect(r.errors).toEqual([]);
    const local = await db.courses.get(id);
    expect(local?.archivedAt).toBe(ARCHIVED);
    expect(local).not.toHaveProperty('archived_edited_at');
    expect(local).not.toHaveProperty('archivedEditedAt');
  });
});
