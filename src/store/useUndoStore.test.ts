import { describe, it, expect, beforeEach, vi } from 'vitest';
import { commitPendingDelete, deleteWithUndo, undoPendingDelete, useUndoStore, UNDO_WINDOW_MS } from './useUndoStore';

// v1.22 (NCC#293) — a delete is held for the undo window, never run and
// reverted, so nothing is pushed unless it stands.

beforeEach(async () => {
  vi.useRealTimers();
  await commitPendingDelete();
  vi.useFakeTimers();
});

describe('deleteWithUndo', () => {
  it('hides the row at once and deletes it only when the window ends', async () => {
    const commit = vi.fn();
    deleteWithUndo('t1', 'Milk', commit);
    expect(useUndoStore.getState().hidden.has('t1')).toBe(true);
    expect(commit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS);
    expect(commit).toHaveBeenCalledOnce();
    expect(useUndoStore.getState().hidden.has('t1')).toBe(false);
    expect(useUndoStore.getState().pending).toBeNull();
  });

  it('Undo shows the row again and nothing is deleted', async () => {
    const commit = vi.fn();
    deleteWithUndo('t2', 'Rent', commit);
    undoPendingDelete();
    await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS * 2);
    expect(commit).not.toHaveBeenCalled();
    expect(useUndoStore.getState().hidden.size).toBe(0);
  });

  it('a second delete commits the first right away', async () => {
    const first = vi.fn();
    const second = vi.fn();
    deleteWithUndo('a', 'A', first);
    deleteWithUndo('b', 'B', second);
    await vi.advanceTimersByTimeAsync(0);
    expect(first).toHaveBeenCalledOnce();
    expect(second).not.toHaveBeenCalled();
    expect(useUndoStore.getState().pending?.id).toBe('b');
  });
});
