import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeClient } from '../test/fakePostgrest';

// v1.16 (limecore#16) — what an error report contains, and when one is sent.
// The privacy policy (#50) describes exactly this, so these are its tests too.

const holder = vi.hoisted(() => ({ session: null as null | { user: { id: string } }, inserts: [] as any[], fail: false, client: null as any }));
vi.mock('./supabase', () => ({
  get supabase() {
    return {
      auth: { getSession: async () => ({ data: { session: holder.session } }) },
      from: (table: string) => {
        if (holder.client) return holder.client.from(table);
        return {
          insert: async (row: any) => {
            if (holder.fail) return { error: { message: 'network' } };
            holder.inserts.push({ table, row });
            return { error: null };
          },
        };
      },
    };
  },
}));

const mod = await import('./errorReports');
const { scrub, buildReport, currentScreen, osVersion, sendReport, setErrorReportsEnabled, installGlobalErrorHandlers, resetErrorReportsForTests } = mod;
const { serverOnlyData } = await import('./dataRights');

const USER = { id: 'user-1' };

function thrown(message: string, name = 'TypeError'): Error {
  const e = new Error(message);
  e.name = name;
  e.stack = `${name}: ${message}\n    at renderGoal (https://localhost/assets/index-abc123.js?v=9:1:204511)\n    at x (https://localhost/assets/vendor.js:2:10)`;
  return e;
}

beforeEach(() => {
  localStorage.clear();
  resetErrorReportsForTests();
  holder.session = { user: USER };
  holder.inserts = [];
  holder.fail = false;
  holder.client = null;
});

describe('what a report contains', () => {
  it('strips email addresses and runs of six or more digits from the message', () => {
    expect(scrub('no user anna.k@example.com with iban 12345678 or pin 1234', 500)).toBe(
      'no user [email] with iban [number] or pin 1234',
    );
  });

  it('cuts the message to 500 characters and the stack to 4,000', () => {
    const r = buildReport(thrown('x'.repeat(900)));
    expect(r.message).toHaveLength(500);
    const long = thrown('m');
    long.stack = 'TypeError: m\n' + Array.from({ length: 400 }, (_, i) => `    at f${i} (https://localhost/a.js:1:${i})`).join('\n');
    expect(buildReport(long).stack.length).toBeLessThanOrEqual(4000);
  });

  it('keeps stack frames but drops the stack\'s own copy of the message', () => {
    const r = buildReport(thrown('balance for anna.k@example.com'));
    expect(r.stack).not.toContain('anna');
    expect(r.stack).not.toContain('TypeError:');
    expect(r.stack).toContain('at renderGoal');
    expect(r.message).toBe('balance for [email]');
  });

  it('fingerprints by error name and first frame, without the bundle query string', () => {
    expect(buildReport(thrown('a')).fingerprint).toBe('TypeError@at renderGoal (https://localhost/assets/index-abc123.js:1:204511)');
    // Same error, different message: same fingerprint, so it is deduplicated.
    expect(buildReport(thrown('b')).fingerprint).toBe(buildReport(thrown('a')).fingerprint);
  });

  it('records the screen with ids and query strings removed', () => {
    expect(currentScreen({ hash: '#/finance/account/0b6f2c1e-8a2d-4b8e-9c61-3f1f0c9d2a11?tab=x' })).toBe('/finance/account/:id');
    expect(currentScreen({ hash: '#/tasks/add?id=42' })).toBe('/tasks/add');
    expect(currentScreen({ pathname: '/today' })).toBe('/today');
  });

  it('reduces the user agent to OS and engine versions', () => {
    const ua = 'Mozilla/5.0 (Linux; Android 14; SM-S921B Build/UP1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/128.0.6613.146 Mobile Safari/537.36';
    expect(osVersion(ua)).toBe('Android 14 · Chrome/128');
  });

  it('carries only the documented fields — nothing about the user or their data', () => {
    expect(Object.keys(buildReport(thrown('x'))).sort()).toEqual(
      ['app', 'app_version', 'error_name', 'fingerprint', 'message', 'os_version', 'platform', 'screen', 'stack'].sort(),
    );
  });

  it('handles a thrown non-Error', () => {
    expect(buildReport('boom').message).toBe('boom');
    expect(buildReport({ weird: true }).error_name).toBe('Error');
  });
});

describe('when a report is sent', () => {
  it('sends nothing while the switch is off (the default)', async () => {
    expect(await sendReport(buildReport(thrown('x')))).toBe('off');
    expect(holder.inserts).toEqual([]);
  });

  it('the crash screen\'s one-time consent sends even with the switch off', async () => {
    expect(await sendReport(buildReport(thrown('x')), { consent: true })).toBe('sent');
    expect(holder.inserts).toHaveLength(1);
    expect(holder.inserts[0].table).toBe('client_errors');
    expect('user_id' in holder.inserts[0].row).toBe(false); // the server fills it in
  });

  it('a guest never sends, whatever the switch says', async () => {
    holder.session = null;
    setErrorReportsEnabled(true);
    expect(await sendReport(buildReport(thrown('x')))).toBe('guest');
    expect(await sendReport(buildReport(thrown('x')), { consent: true })).toBe('guest');
    expect(holder.inserts).toEqual([]);
  });

  it('the same error is sent once per session', async () => {
    setErrorReportsEnabled(true);
    expect(await sendReport(buildReport(thrown('a')))).toBe('sent');
    expect(await sendReport(buildReport(thrown('b')))).toBe('duplicate');
    expect(holder.inserts).toHaveLength(1);
  });

  it('a failed send is not counted as sent, so it can be retried', async () => {
    setErrorReportsEnabled(true);
    holder.fail = true;
    expect(await sendReport(buildReport(thrown('a')))).toBe('failed');
    holder.fail = false;
    expect(await sendReport(buildReport(thrown('a')))).toBe('sent');
  });

  it('the switch persists across restarts', () => {
    setErrorReportsEnabled(true);
    resetErrorReportsForTests();
    expect(mod.errorReportsEnabled()).toBe(true);
    setErrorReportsEnabled(false);
    resetErrorReportsForTests();
    expect(mod.errorReportsEnabled()).toBe(false);
  });
});

describe('uncaught errors and rejections', () => {
  function fakeWindow() {
    const handlers: Record<string, ((ev: any) => void)[]> = {};
    return {
      addEventListener: (t: string, h: (ev: any) => void) => void (handlers[t] ??= []).push(h),
      removeEventListener: (t: string, h: (ev: any) => void) => void (handlers[t] = (handlers[t] ?? []).filter((x) => x !== h)),
      fire: (t: string, ev: any) => (handlers[t] ?? []).forEach((h) => h(ev)),
    };
  }
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('are reported only while the switch is on', async () => {
    const w = fakeWindow();
    const off = installGlobalErrorHandlers(w as unknown as Window);
    w.fire('error', { error: thrown('one') });
    await flush();
    expect(holder.inserts).toEqual([]);
    setErrorReportsEnabled(true);
    w.fire('unhandledrejection', { reason: thrown('two', 'RangeError') });
    await flush();
    expect(holder.inserts.map((i) => i.row.error_name)).toEqual(['RangeError']);
    off();
  });
});

describe('the export includes what exists only on the server', () => {
  it('reads the user\'s feedback and error reports', async () => {
    holder.client = fakeClient({
      // RLS returns only the caller's own feedback rows.
      feedback: [{ id: 'f1', user_id: USER.id, message: 'hi' }],
      client_errors: [{ id: 'e1', user_id: USER.id, error_name: 'TypeError' }, { id: 'e2', user_id: 'someone-else', error_name: 'x' }],
    });
    const server = await serverOnlyData(USER.id);
    expect((server.feedback as any[]).map((r) => r.id)).toEqual(['f1']);
    expect((server.client_errors as any[]).map((r) => r.id)).toEqual(['e1']);
  });

  // v1.18.1 (NCC#158): production grants signed-in users nine feedback
  // columns, not user_id; a request naming any other column, or `*`, fails
  // as a whole with 42501. This fake refuses the same way.
  it('asks feedback only for the columns a signed-in user may read', async () => {
    const GRANTED = new Set(['id', 'app', 'app_version', 'category', 'rating', 'message', 'status', 'shipped_in', 'created_at']);
    holder.client = fakeClient(
      { feedback: [{ id: 'f1', message: 'hi' }] },
      {
        failWhen: (req) => {
          if (req.table !== 'feedback') return null;
          const cols = (req.columns ?? '*').split(',').map((c) => c.trim());
          const named = [...cols, ...req.filters.map(([, col]) => col)];
          return named.every((c) => GRANTED.has(c)) ? null : { code: '42501', message: 'permission denied for table feedback' };
        },
      },
    );
    const server = await serverOnlyData(USER.id);
    expect(server.feedback).toEqual([{ id: 'f1', message: 'hi' }]);
  });

  it('says so in the export when a read fails, instead of leaving it out', async () => {
    holder.client = fakeClient({}, { failWhen: (req) => (req.table === 'client_errors' ? { code: '57014', message: 'timeout' } : null) });
    const server = await serverOnlyData(USER.id);
    expect(server.client_errors).toEqual({ error: 'timeout' });
    expect(server.feedback).toEqual([]);
  });
});
