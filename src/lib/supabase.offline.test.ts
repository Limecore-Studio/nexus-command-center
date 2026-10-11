import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// v1.19 — NCC#135 / NCC#139. Two small pieces of the offline fix that live in
// the client module: the no-network read of the stored session, and the time
// limit on every request.

const prefs = vi.hoisted(() => new Map<string, string>());
vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: async ({ key }: { key: string }) => ({ value: prefs.get(key) ?? null }),
    set: async ({ key, value }: { key: string; value: string }) => void prefs.set(key, value),
    remove: async ({ key }: { key: string }) => void prefs.delete(key),
  },
}));

// The module builds its web OAuth redirect from window.location at import.
vi.stubGlobal('window', { location: { origin: 'http://localhost' } });
// createClient() builds the realtime client at import, which needs a WebSocket
// constructor; CI runs Node 20, which has none. Nothing here connects.
if (typeof globalThis.WebSocket === 'undefined') vi.stubGlobal('WebSocket', class {});
const { readStoredSession, fetchWithTimeout } = await import('./supabase');

describe('readStoredSession', () => {
  beforeEach(() => prefs.clear());

  it('returns the session supabase-js stored, without the network', async () => {
    const session = { access_token: 'a', refresh_token: 'r', expires_at: 1, user: { id: 'u-1' } };
    prefs.set('nexus-supabase-session', JSON.stringify(session));
    expect(await readStoredSession()).toEqual(session);
  });

  it('returns null when nothing is stored', async () => {
    expect(await readStoredSession()).toBeNull();
  });

  it('returns null for malformed or incomplete entries', async () => {
    prefs.set('nexus-supabase-session', '{not json');
    expect(await readStoredSession()).toBeNull();
    prefs.set('nexus-supabase-session', JSON.stringify({ access_token: 'a', user: { id: 'u' } }));
    expect(await readStoredSession()).toBeNull();
    prefs.set('nexus-supabase-session', 'null');
    expect(await readStoredSession()).toBeNull();
  });
});

describe('fetchWithTimeout', () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    vi.useFakeTimers();
    // A request that never answers unless it is aborted: Wi-Fi with no route.
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      })) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.useRealTimers();
  });

  it('gives up on a request that never answers after 30 s', async () => {
    const p = fetchWithTimeout('https://example.invalid/rest/v1/x');
    const settled = vi.fn();
    p.catch(settled);
    await vi.advanceTimersByTimeAsync(29_000);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });

  it("still honours the caller's own abort", async () => {
    const outer = new AbortController();
    const p = fetchWithTimeout('https://example.invalid/rest/v1/x', { signal: outer.signal });
    outer.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });
});
