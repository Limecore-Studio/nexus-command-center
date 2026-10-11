import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AuthApiError, AuthRetryableFetchError } from '@supabase/supabase-js';

// v1.19 — NCC#135. Cold start must not wait on the network: offline with an
// expired access token, getSession() refreshes first and that retries for
// ~25 s or more. These pin the head start, the stored-session fallback, and
// the rule that "could not ask" never signs the user out.

type Listener = (event: string, session: unknown) => void;
const h = vi.hoisted(() => ({
  answer: null as null | Promise<{ data: { session: unknown }; error: unknown }>,
  stored: null as unknown,
  listener: null as null | ((event: string, session: unknown) => void),
  published: [] as unknown[],
}));

vi.mock('../lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: () => h.answer,
      onAuthStateChange: (cb: Listener) => {
        h.listener = cb;
        return { data: { subscription: { unsubscribe() {} } } };
      },
    },
  },
  readStoredSession: async () => h.stored,
}));
vi.mock('../lib/ssoPublisher', () => ({
  publishSession: async (s: unknown) => void h.published.push(s),
  clearPublishedSession: async () => {},
}));
vi.mock('../lib/originMarker', () => ({ scheduleOriginStamp: () => {} }));
vi.mock('../lib/guestMode', () => ({ setGuestMode: async () => {} }));
vi.mock('../db/database', () => ({ db: {} }));

const { useSessionStore } = await import('./useSessionStore');

const STORED = { access_token: 'old', refresh_token: 'r', expires_at: 1, user: { id: 'u-1' } };
const FRESH = { access_token: 'new', refresh_token: 'r2', expires_at: 2, user: { id: 'u-1' } };

function deferred() {
  let resolve!: (v: { data: { session: unknown }; error: unknown }) => void;
  const promise = new Promise<{ data: { session: unknown }; error: unknown }>((r) => (resolve = r));
  return { promise, resolve };
}

beforeEach(() => {
  vi.useFakeTimers();
  h.stored = null;
  h.listener = null;
  h.published = [];
  useSessionStore.setState({
    session: null,
    user: null,
    loading: true,
    initialized: false,
    sessionUnverified: false,
  });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('useSessionStore.init (NCC#135)', () => {
  it('uses getSession when it answers inside the head start', async () => {
    h.answer = Promise.resolve({ data: { session: FRESH }, error: null });
    await useSessionStore.getState().init();
    const s = useSessionStore.getState();
    expect(s.user).toEqual(FRESH.user);
    expect(s.sessionUnverified).toBe(false);
    expect(s.loading).toBe(false);
    expect(h.published).toEqual([FRESH]);
  });

  it('opens on the stored session when the refresh is still running, then takes the real answer', async () => {
    const d = deferred();
    h.answer = d.promise;
    h.stored = STORED;
    const init = useSessionStore.getState().init();
    await vi.advanceTimersByTimeAsync(1500);
    await init;
    let s = useSessionStore.getState();
    expect(s.loading).toBe(false);
    expect(s.user).toEqual(STORED.user);
    expect(s.sessionUnverified).toBe(true);

    d.resolve({ data: { session: FRESH }, error: null });
    await vi.runAllTimersAsync();
    s = useSessionStore.getState();
    expect(s.session).toEqual(FRESH);
    expect(s.sessionUnverified).toBe(false);
    expect(h.published).toEqual([FRESH]);
  });

  it('keeps the stored session when the background refresh fails on the network', async () => {
    const d = deferred();
    h.answer = d.promise;
    h.stored = STORED;
    const init = useSessionStore.getState().init();
    await vi.advanceTimersByTimeAsync(1500);
    await init;

    d.resolve({ data: { session: null }, error: new AuthRetryableFetchError('Failed to fetch', 0) });
    await vi.runAllTimersAsync();
    const s = useSessionStore.getState();
    expect(s.user).toEqual(STORED.user);
    expect(s.sessionUnverified).toBe(true);
    // Nothing published: the bridge keeps what it last had.
    expect(h.published).toEqual([]);
  });

  it('keeps the stored session when the network failure comes back inside the head start', async () => {
    h.answer = Promise.resolve({ data: { session: null }, error: new AuthRetryableFetchError('Failed to fetch', 0) });
    h.stored = STORED;
    await useSessionStore.getState().init();
    const s = useSessionStore.getState();
    expect(s.user).toEqual(STORED.user);
    expect(s.sessionUnverified).toBe(true);
  });

  it('signs out on a real answer (refresh token rejected)', async () => {
    const d = deferred();
    h.answer = d.promise;
    h.stored = STORED;
    const init = useSessionStore.getState().init();
    await vi.advanceTimersByTimeAsync(1500);
    await init;

    d.resolve({ data: { session: null }, error: new AuthApiError('Invalid Refresh Token', 400, 'refresh_token_not_found') });
    await vi.runAllTimersAsync();
    const s = useSessionStore.getState();
    expect(s.user).toBeNull();
    expect(s.sessionUnverified).toBe(false);
  });

  it('shows Login straight away when nobody is stored', async () => {
    h.answer = Promise.resolve({ data: { session: null }, error: null });
    await useSessionStore.getState().init();
    const s = useSessionStore.getState();
    expect(s.user).toBeNull();
    expect(s.loading).toBe(false);
    expect(s.sessionUnverified).toBe(false);
  });

  it('ignores INITIAL_SESSION with no session while unverified, but honours SIGNED_OUT', async () => {
    const d = deferred();
    h.answer = d.promise;
    h.stored = STORED;
    const init = useSessionStore.getState().init();
    await vi.advanceTimersByTimeAsync(1500);
    await init;

    h.listener!('INITIAL_SESSION', null);
    expect(useSessionStore.getState().user).toEqual(STORED.user);

    h.listener!('SIGNED_OUT', null);
    const s = useSessionStore.getState();
    expect(s.user).toBeNull();
    expect(s.sessionUnverified).toBe(false);
  });

  it('a later TOKEN_REFRESHED verifies the session', async () => {
    const d = deferred();
    h.answer = d.promise;
    h.stored = STORED;
    const init = useSessionStore.getState().init();
    await vi.advanceTimersByTimeAsync(1500);
    await init;

    h.listener!('TOKEN_REFRESHED', FRESH);
    const s = useSessionStore.getState();
    expect(s.session).toEqual(FRESH);
    expect(s.sessionUnverified).toBe(false);
  });
});
