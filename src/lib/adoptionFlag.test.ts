import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// v1.19 — NCC#139. Offline, the "Existing data found" prompt appeared on every
// launch (a failed flag read counted as "not dismissed") and then locked the
// app. These pin the three-state read and the on-device decision marker.

const h = vi.hoisted(() => ({
  read: null as null | (() => Promise<unknown>),
  upsertError: null as null | { message: string },
  upserts: 0,
}));
vi.mock('./supabase', () => ({
  supabase: {
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: () => h.read!() }) }),
      upsert: async () => {
        h.upserts++;
        return { error: h.upsertError };
      },
    }),
  },
}));

const { getDismissedFromCloud, readDecided, recordDecision, FLAG_READ_TIMEOUT_MS } = await import('./adoptionFlag');

beforeEach(() => {
  localStorage.clear();
  h.upsertError = null;
  h.upserts = 0;
});

describe('getDismissedFromCloud', () => {
  afterEach(() => vi.useRealTimers());

  it('returns the stored flag when the cloud answers', async () => {
    h.read = async () => ({ data: { ncc_local_data_prompt_dismissed: true }, error: null });
    expect(await getDismissedFromCloud('u')).toBe(true);
    h.read = async () => ({ data: null, error: null });
    expect(await getDismissedFromCloud('u')).toBe(false);
  });

  it('returns null (unknown), not false, when the read fails', async () => {
    h.read = async () => ({ data: null, error: { message: 'TypeError: Failed to fetch' } });
    expect(await getDismissedFromCloud('u')).toBeNull();
    h.read = async () => {
      throw new Error('boom');
    };
    expect(await getDismissedFromCloud('u')).toBeNull();
  });

  it('returns null when the read never answers', async () => {
    vi.useFakeTimers();
    h.read = () => new Promise(() => {});
    const p = getDismissedFromCloud('u');
    await vi.advanceTimersByTimeAsync(FLAG_READ_TIMEOUT_MS);
    expect(await p).toBeNull();
  });
});

describe('recordDecision', () => {
  it('remembers the decision on the device at once, then marks it synced', async () => {
    recordDecision('u');
    expect(readDecided('u')).toBe('pending');
    await vi.waitFor(() => expect(readDecided('u')).toBe('synced'));
    expect(h.upserts).toBe(1);
  });

  it('stays pending when the cloud write fails, so a later launch retries it', async () => {
    h.upsertError = { message: 'offline' };
    recordDecision('u');
    await vi.waitFor(() => expect(h.upserts).toBe(1));
    expect(readDecided('u')).toBe('pending');
  });

  it('is per user', () => {
    recordDecision('a');
    expect(readDecided('a')).toBe('pending');
    expect(readDecided('b')).toBeNull();
  });
});
