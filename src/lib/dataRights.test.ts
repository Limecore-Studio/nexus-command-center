import { describe, it, expect, beforeEach, vi } from 'vitest';

// v1.21.1 (limecore#102) — deleting an account never pretends. "Guest or
// account" comes from the device (a stored session, the last signed-in user),
// so a session that cannot be refreshed no longer reads as a guest.

const h = vi.hoisted(() => ({
  session: null as null | { user: { id: string } },
  sessionError: null as null | { message: string },
  stored: null as null | object,
  invokeError: null as null | { message: string },
  invoked: 0,
  signOuts: [] as unknown[],
}));

vi.mock('./supabase', () => ({
  readStoredSession: async () => h.stored,
  get supabase() {
    return {
      auth: {
        getSession: async () => ({ data: { session: h.session }, error: h.sessionError }),
        signOut: async (opts: unknown) => {
          h.signOuts.push(opts);
          return { error: null };
        },
      },
      functions: {
        invoke: async () => {
          h.invoked++;
          return { error: h.invokeError };
        },
      },
    };
  },
}));

const { deleteAccount } = await import('./dataRights');
const { LAST_USER_KEY } = await import('./adoptionChoice');

let wiped = 0;
const clearLocal = async () => {
  wiped++;
};

beforeEach(() => {
  localStorage.clear();
  Object.assign(h, { session: null, sessionError: null, stored: null, invokeError: null, invoked: 0, signOuts: [] });
  wiped = 0;
});

describe('deleteAccount', () => {
  it('refuses and wipes nothing when an account is recorded but the session is gone', async () => {
    localStorage.setItem(LAST_USER_KEY, 'user-1');
    expect(await deleteAccount({ clearLocal })).toEqual({ deleted: 'nothing', reason: 'signed-out' });
    expect(wiped).toBe(0);
    expect(h.invoked).toBe(0);
  });

  it('refuses when a session is stored but cannot be refreshed', async () => {
    h.stored = { user: { id: 'user-1' }, refresh_token: 'r' };
    h.sessionError = { message: 'Invalid Refresh Token' };
    expect((await deleteAccount({ clearLocal })).deleted).toBe('nothing');
    expect(wiped).toBe(0);
    expect(h.invoked).toBe(0);
  });

  it('refuses on a getSession error even with nothing recorded', async () => {
    h.sessionError = { message: 'Failed to fetch' };
    expect((await deleteAccount({ clearLocal })).deleted).toBe('nothing');
    expect(wiped).toBe(0);
  });

  it('wipes the device for a real guest and says there was no account', async () => {
    expect(await deleteAccount({ clearLocal })).toEqual({ deleted: 'local' });
    expect(wiped).toBe(1);
    expect(h.invoked).toBe(0);
  });

  it('treats the guest marker as a guest', async () => {
    localStorage.setItem(LAST_USER_KEY, 'guest');
    expect((await deleteAccount({ clearLocal })).deleted).toBe('local');
    expect(wiped).toBe(1);
  });

  it('deletes the account, then removes the stored session locally and wipes', async () => {
    h.session = { user: { id: 'user-1' } };
    expect(await deleteAccount({ clearLocal })).toEqual({ deleted: 'account' });
    expect(h.invoked).toBe(1);
    expect(h.signOuts).toEqual([{ scope: 'local' }]);
    expect(wiped).toBe(1);
  });

  it('wipes nothing when the server refuses', async () => {
    h.session = { user: { id: 'user-1' } };
    h.invokeError = { message: 'boom' };
    await expect(deleteAccount({ clearLocal })).rejects.toThrow('boom');
    expect(wiped).toBe(0);
    expect(h.signOuts).toEqual([]);
  });
});
