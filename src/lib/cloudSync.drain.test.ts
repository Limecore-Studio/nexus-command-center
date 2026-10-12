import { describe, it, expect, beforeEach, vi } from 'vitest';

// v1.18.1 (NCC#147) — a parent that fails for a reason that will pass (no
// network, a timeout) must not cost its child. The child's FK violation
// (23503) used to be classed permanent, so it was marked synced as
// "[dropped]" and never retried, even once the parent landed.

const holder = vi.hoisted(() => ({ client: null as any }));
vi.mock('./supabase', () => ({
  get supabase() {
    return holder.client;
  },
}));

const { pushQueue, isTransportError } = await import('./cloudSync');
const { enqueue, listPending } = await import('../db/syncQueue');
const { db } = await import('../db/database');

const server: Record<string, any[]> = {};
let down = new Set<string>();
let timeoutOn = new Set<string>();
let calls: string[] = [];

function client() {
  return {
    from(table: string) {
      const write = (row: any) => {
        calls.push(table);
        // What supabase-js returns for a fetch that failed or was aborted.
        if (down.has(table)) return Promise.resolve({ error: { message: 'TypeError: Failed to fetch', details: '', hint: '', code: '' } });
        // A database answer that is not the payload's fault.
        if (timeoutOn.has(table)) return Promise.resolve({ error: { message: 'canceling statement due to statement timeout', code: '57014' } });
        if (table === 'habit_completions' && !(server.habits ?? []).some((h) => h.id === row.habit_id)) {
          return Promise.resolve({ error: { code: '23503', message: 'violates foreign key constraint "habit_completions_habit_id_fkey"' } });
        }
        (server[table] ??= []).push(row);
        return Promise.resolve({ error: null });
      };
      return { upsert: write, insert: write };
    },
  };
}

async function habitWithCompletion() {
  const habitId = crypto.randomUUID();
  await enqueue('habit', habitId, 'insert', {
    id: habitId, title: 'Run', type: 'boolean', frequencyKind: 'daily', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z',
  });
  await enqueue('habit_completion', crypto.randomUUID(), 'insert', { id: crypto.randomUUID(), habitId, date: '2026-10-01', amount: 1 });
  return habitId;
}

beforeEach(async () => {
  holder.client = client();
  for (const k of Object.keys(server)) delete server[k];
  down = new Set();
  timeoutOn = new Set();
  calls = [];
  await Promise.all(db.tables.map((t) => t.clear()));
});

describe('pushQueue after a parent fails (NCC#147)', () => {
  it('stops at the first network failure; nothing behind it is tried or dropped', async () => {
    await habitWithCompletion();
    down.add('habits');
    const r1 = await pushQueue('u1');
    expect(calls).toEqual(['habits']);
    expect(r1.attempted).toBe(1);
    expect(await listPending()).toHaveLength(2);

    down = new Set();
    await pushQueue('u1');
    expect(server.habits).toHaveLength(1);
    expect(server.habit_completions).toHaveLength(1);
    expect(await listPending()).toHaveLength(0);
  });

  it('keeps the child pending when its parent failed on a database error that can pass', async () => {
    await habitWithCompletion();
    timeoutOn.add('habits');
    const r1 = await pushQueue('u1');
    expect(r1.errors.some((e) => e.message.includes('[dropped'))).toBe(false);
    expect(await listPending()).toHaveLength(2);

    timeoutOn = new Set();
    await pushQueue('u1');
    expect(server.habit_completions).toHaveLength(1);
    expect(await listPending()).toHaveLength(0);
  });

  it('still drops a child whose parent is simply not there', async () => {
    await enqueue('habit_completion', crypto.randomUUID(), 'insert', { id: crypto.randomUUID(), habitId: crypto.randomUUID(), date: '2026-10-01', amount: 1 });
    const r = await pushQueue('u1');
    expect(r.errors[0].message).toContain('[dropped');
    expect(await listPending()).toHaveLength(0);
  });
});

describe('isTransportError', () => {
  it('is true for failed or aborted fetches, false for answers from the server', () => {
    expect(isTransportError({ message: 'TypeError: Failed to fetch', code: '' })).toBe(true);
    // A body with no code: the server answered (gateway or WAF page), so the
    // drain carries on rather than stopping at a possibly payload-specific item.
    expect(isTransportError({ message: '<html>502 Bad Gateway</html>' })).toBe(false);
    expect(isTransportError(new DOMException('Aborted', 'AbortError'))).toBe(true);
    expect(isTransportError({ message: 'fk', code: '23503' })).toBe(false);
    expect(isTransportError({ message: 'timeout', code: '57014' })).toBe(false);
    expect(isTransportError(new Error('subjectId is required'))).toBe(false);
  });
});

describe('pushQueue when the session ends mid-drain (NCC#162)', () => {
  it('keeps items queued on an RLS refusal with no session, and still drops one with a session', async () => {
    let session: unknown = null;
    const refuse = { upsert: () => Promise.resolve({ error: { code: '42501', message: 'new row violates row-level security policy' } }) };
    holder.client = { auth: { getSession: async () => ({ data: { session } }) }, from: () => refuse };
    await habitWithCompletion();
    const r1 = await pushQueue('u1');
    expect(r1.attempted).toBe(1);
    expect(r1.errors[0].message).not.toContain('[dropped');
    expect(await listPending()).toHaveLength(2);

    session = { user: { id: 'u1' } };
    const r2 = await pushQueue('u1');
    expect(r2.errors.every((e) => e.message.includes('[dropped'))).toBe(true);
  });
});
