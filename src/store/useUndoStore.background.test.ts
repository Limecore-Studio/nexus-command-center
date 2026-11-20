import { describe, it, expect, vi, beforeEach } from 'vitest';

// v1.22 (NCC#293 review) — a held delete is committed when the app goes to
// the background, so Android killing the app inside the undo window cannot
// bring the row back.

const h = vi.hoisted(() => ({ pause: null as null | (() => void) }));
vi.mock('@capacitor/core', async (orig) => ({
  ...(await orig<typeof import('@capacitor/core')>()),
  Capacitor: { isNativePlatform: () => true, getPlatform: () => 'android' },
}));
vi.mock('@capacitor/app', () => ({
  App: {
    addListener: async (name: string, fn: () => void) => {
      if (name === 'pause') h.pause = fn;
      return { remove: () => {} };
    },
  },
}));

// A page whose visibility the test controls.
const page = Object.assign(new EventTarget(), { visibilityState: 'visible' as 'visible' | 'hidden' });
vi.stubGlobal('document', page);

const { deleteWithUndo, useUndoStore } = await import('./useUndoStore');
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  page.visibilityState = 'visible';
});

describe('background commit', () => {
  it('the page going hidden commits the held delete', async () => {
    const commit = vi.fn();
    deleteWithUndo('t1', 'Milk', commit);
    expect(commit).not.toHaveBeenCalled();
    page.visibilityState = 'hidden';
    page.dispatchEvent(new Event('visibilitychange'));
    await flush();
    expect(commit).toHaveBeenCalledOnce();
    expect(useUndoStore.getState().pending).toBeNull();
    expect(useUndoStore.getState().hidden.has('t1')).toBe(false);
  });

  it("Capacitor's pause commits it too", async () => {
    const commit = vi.fn();
    deleteWithUndo('t2', 'Rent', commit);
    await flush();
    expect(h.pause).toBeTypeOf('function');
    h.pause!();
    await flush();
    expect(commit).toHaveBeenCalledOnce();
  });

  it('becoming visible again commits nothing', async () => {
    const commit = vi.fn();
    deleteWithUndo('t3', 'Bread', commit);
    page.dispatchEvent(new Event('visibilitychange'));
    await flush();
    expect(commit).not.toHaveBeenCalled();
    page.visibilityState = 'hidden';
    page.dispatchEvent(new Event('visibilitychange'));
    await flush();
  });
});
