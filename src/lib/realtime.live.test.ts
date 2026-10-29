import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// v1.20 (NCC#221, limecore#68) — live sync v2: a dropped channel comes back,
// a rejoin resyncs, and the private hint channel pulls only what it names.

type Cb = (...a: any[]) => void;
const h = vi.hoisted(() => ({
  channels: [] as any[],
  sent: [] as any[],
  tokens: [] as string[],
  syncNow: 0,
  pulled: [] as string[][],
  announcer: null as null | ((t: string[]) => void),
}));

vi.mock('./supabase', () => ({
  supabase: {
    channel(name: string, opts?: unknown) {
      const ch = {
        name,
        opts,
        state: 'joining',
        bindings: [] as any[],
        broadcast: [] as Cb[],
        system: null as Cb | null,
        cb: null as Cb | null,
        on(type: string, filter: any, cb: Cb) {
          if (type === 'system') this.system = cb;
          else if (type === 'broadcast') this.broadcast.push(cb);
          else this.bindings.push({ ...filter, cb });
          return this;
        },
        subscribe(cb: Cb) {
          this.cb = cb;
          return this;
        },
        send(msg: any) {
          h.sent.push({ topic: name, ...msg });
          return Promise.resolve('ok');
        },
      };
      h.channels.push(ch);
      return ch;
    },
    removeChannel(ch: any) {
      ch.state = 'closed';
      return Promise.resolve('ok');
    },
    auth: { getSession: async () => ({ data: { session: { access_token: 'tok-2' } } }) },
    realtime: {
      setAuth: async (t: string) => {
        h.tokens.push(t);
      },
    },
  },
}));
vi.mock('../store/useSyncStore', () => ({
  useSyncStore: {
    getState: () => ({
      syncNow: async () => {
        h.syncNow++;
      },
      pullTables: async (t: string[]) => {
        h.pulled.push(t);
      },
    }),
  },
  setPushAnnouncer: (fn: null | ((t: string[]) => void)) => {
    h.announcer = fn;
  },
}));

vi.stubGlobal('window', new EventTarget());
const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
vi.stubGlobal('document', doc);

const rt = await import('./realtime');
const { DEVICE_ID } = await import('./liveHints');
const { getRealtimeState } = await import('./realtimeState');

const changes = () => h.channels.filter((c) => c.name === 'nexus-sync');
const hints = () => h.channels.filter((c) => c.name === 'user:u-1');
const lastChange = () => changes()[changes().length - 1];

beforeEach(() => {
  vi.useFakeTimers();
  h.channels.length = 0;
  h.sent.length = 0;
  h.tokens.length = 0;
  h.syncNow = 0;
  h.pulled.length = 0;
});
afterEach(() => {
  rt.stopRealtime();
  vi.useRealTimers();
});

describe('channel lifecycle', () => {
  it('reports connecting, live, down, then live again on a new channel', async () => {
    rt.startRealtime('u-1');
    expect(getRealtimeState()).toBe('connecting');
    changes()[0].cb('SUBSCRIBED');
    expect(getRealtimeState()).toBe('live');
    changes()[0].cb('CHANNEL_ERROR', new Error('socket closed'));
    expect(getRealtimeState()).toBe('down');
    // A late callback from the removed channel changes nothing.
    changes()[0].cb('SUBSCRIBED');
    expect(getRealtimeState()).toBe('down');
    await vi.advanceTimersByTimeAsync(1000);
    expect(changes()).toHaveLength(2);
    expect(h.tokens).toEqual(['tok-2']);
    changes()[1].cb('SUBSCRIBED');
    expect(getRealtimeState()).toBe('live');
  });

  it('the first join does not resync, a rejoin does', async () => {
    rt.startRealtime('u-1');
    changes()[0].cb('SUBSCRIBED');
    expect(h.syncNow).toBe(0);
    changes()[0].cb('TIMED_OUT');
    await vi.advanceTimersByTimeAsync(1000);
    changes()[1].cb('SUBSCRIBED');
    expect(h.syncNow).toBe(1);
  });

  it('backs off 1 s, 2 s … capped at 30 s', async () => {
    rt.startRealtime('u-1');
    const fail = () => lastChange().cb('CHANNEL_ERROR', new Error('x'));
    fail();
    await vi.advanceTimersByTimeAsync(999);
    expect(changes()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(changes()).toHaveLength(2);
    fail();
    await vi.advanceTimersByTimeAsync(2000);
    expect(changes()).toHaveLength(3);
    for (let i = 0; i < 6; i++) {
      fail();
      await vi.advanceTimersByTimeAsync(30_000);
    }
    fail();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(changes()).toHaveLength(9);
    await vi.advanceTimersByTimeAsync(1);
    expect(changes()).toHaveLength(10);
  });

  it('a rejected subscription (system error) is a drop like any other', async () => {
    rt.startRealtime('u-1');
    changes()[0].cb('SUBSCRIBED');
    changes()[0].system({ status: 'error', message: 'Unable to subscribe' });
    expect(getRealtimeState()).toBe('down');
    await vi.advanceTimersByTimeAsync(1000);
    expect(changes()).toHaveLength(2);
  });

  it.each(['resume', 'visibilitychange', 'online'])('rejoins at once on %s', async (event) => {
    rt.startRealtime('u-1');
    for (let i = 0; i < 5; i++) {
      lastChange().cb('CHANNEL_ERROR', new Error('x'));
      await vi.advanceTimersByTimeAsync(30_000);
    }
    lastChange().cb('CHANNEL_ERROR', new Error('x'));
    const before = changes().length;
    (event === 'online' ? (window as unknown as EventTarget) : doc).dispatchEvent(new Event(event));
    await vi.advanceTimersByTimeAsync(0);
    expect(changes()).toHaveLength(before + 1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(changes()).toHaveLength(before + 1);
  });

  it('a different user replaces the channels; the same user keeps them', () => {
    rt.startRealtime('u-1');
    rt.startRealtime('u-1');
    expect(changes()).toHaveLength(1);
    rt.startRealtime('u-2');
    expect(changes()).toHaveLength(2);
    expect(changes()[0].state).toBe('closed');
    expect(h.channels.some((c) => c.name === 'user:u-2')).toBe(true);
  });

  it('a postgres_changes event still runs the full sync, coalesced', async () => {
    rt.startRealtime('u-1');
    const b = changes()[0].bindings;
    b[0].cb({});
    b[1].cb({});
    await vi.advanceTimersByTimeAsync(1500);
    expect(h.syncNow).toBe(1);
  });
});

describe('hints', () => {
  it('joins the private user topic', () => {
    rt.startRealtime('u-1');
    expect(hints()[0].opts).toEqual({ config: { private: true, broadcast: { self: false } } });
  });

  it('pulls only hinted tables NCC holds, after 300 ms, ignoring its own echoes', async () => {
    rt.startRealtime('u-1');
    const deliver = (payload: unknown) => hints()[0].broadcast.forEach((cb: Cb) => cb({ payload }));
    deliver({ app: 'studydesk', table: 'grades', device: 'sd' });
    deliver({ app: 'limelog', table: 'workout_sessions', device: 'll' });
    deliver({ app: 'studydesk', table: 'assignments', device: 'sd' });
    deliver({ app: 'ncc', table: 'transactions', device: DEVICE_ID });
    await vi.advanceTimersByTimeAsync(299);
    expect(h.pulled).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.pulled.map((t) => [...t].sort())).toEqual([['grades', 'workout_sessions']]);
    expect(h.syncNow).toBe(0);
  });

  it('stands down for the session when Realtime Authorization refuses the topic', async () => {
    rt.startRealtime('u-1');
    hints()[0].cb('CHANNEL_ERROR', new Error('Unauthorized: You do not have permissions to read from this Channel topic: user:u-1'));
    await vi.advanceTimersByTimeAsync(60_000);
    doc.dispatchEvent(new Event('resume'));
    await vi.advanceTimersByTimeAsync(0);
    expect(hints()).toHaveLength(1);
  });

  it('announces one hint per table once joined, names only', () => {
    rt.startRealtime('u-1');
    h.announcer!(['transactions']);
    expect(h.sent).toEqual([]);
    hints()[0].cb('SUBSCRIBED');
    h.announcer!(['transactions', 'budget_categories', 'transactions']);
    expect(h.sent.map((m) => [m.topic, m.event, m.payload.table, m.payload.app, m.payload.device])).toEqual([
      ['user:u-1', 'changed', 'transactions', 'ncc', DEVICE_ID],
      ['user:u-1', 'changed', 'budget_categories', 'ncc', DEVICE_ID],
    ]);
    expect(Object.keys(h.sent[0].payload).sort()).toEqual(['app', 'at', 'device', 'table']);
  });

  it('stopping removes the announcer and cancels pending work', async () => {
    rt.startRealtime('u-1');
    hints()[0].cb('SUBSCRIBED');
    hints()[0].broadcast[0]({ payload: { table: 'grades', device: 'sd' } });
    rt.stopRealtime();
    expect(h.announcer).toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.pulled).toEqual([]);
    expect(getRealtimeState()).toBe('off');
  });
});
