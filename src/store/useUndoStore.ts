// v1.22 (NCC#293) — undo over confirm for deletes that are frequent and fully
// reversible (transactions, tasks).
//
// The delete is HELD for the undo window instead of run and reverted: a run
// delete already queues its tombstone, and a tombstone cannot be revived by a
// later write (the server's delete-wins rule), so "undo" would have to fight
// the sync. Here the row is only hidden; when the window ends the real delete
// runs (and queues its push); Undo just shows the row again. Nothing is pushed
// unless the delete stands. One at a time: a second delete commits the first.
//
// Leaving the app commits it at once (the page going hidden, or Capacitor's
// `pause`): Android may kill a backgrounded app inside the window, and a
// delete the user made must not come back because of that. Undo is only
// offered while the app is in front.
import { create } from 'zustand';
import { Capacitor } from '@capacitor/core';
import { App as CapacitorApp } from '@capacitor/app';

export const UNDO_WINDOW_MS = 5000;

interface Pending {
  /** The row being deleted; lists hide it while it waits. */
  id: string;
  /** What the bar names. */
  label: string;
  commit: () => Promise<void> | void;
}

interface UndoState {
  pending: Pending | null;
  hidden: ReadonlySet<string>;
}

export const useUndoStore = create<UndoState>(() => ({ pending: null, hidden: new Set() }));

let timer: ReturnType<typeof setTimeout> | null = null;

function unhide(id: string): void {
  const hidden = new Set(useUndoStore.getState().hidden);
  hidden.delete(id);
  useUndoStore.setState({ hidden });
}

/** Runs the waiting delete now, if there is one. */
export async function commitPendingDelete(): Promise<void> {
  const p = useUndoStore.getState().pending;
  if (timer) clearTimeout(timer);
  timer = null;
  if (!p) return;
  useUndoStore.setState({ pending: null });
  try {
    await p.commit();
  } finally {
    // After the delete, so the row never flashes back in between.
    unhide(p.id);
  }
}

let backgroundCommitInstalled = false;
/** Once, on the first held delete: going to the background commits it. */
function installBackgroundCommit(): void {
  if (backgroundCommitInstalled) return;
  backgroundCommitInstalled = true;
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') void commitPendingDelete();
    });
  }
  if (Capacitor.isNativePlatform()) {
    void CapacitorApp.addListener('pause', () => void commitPendingDelete()).catch(() => {});
  }
}

/** Hides the row now and deletes it when the undo window ends, or when the
 *  app goes to the background, whichever comes first. */
export function deleteWithUndo(id: string, label: string, commit: () => Promise<void> | void): void {
  installBackgroundCommit();
  void commitPendingDelete();
  const hidden = new Set(useUndoStore.getState().hidden);
  hidden.add(id);
  useUndoStore.setState({ pending: { id, label, commit }, hidden });
  timer = setTimeout(() => void commitPendingDelete(), UNDO_WINDOW_MS);
}

/** Undo: the row shows again and nothing is deleted. */
export function undoPendingDelete(): void {
  const p = useUndoStore.getState().pending;
  if (timer) clearTimeout(timer);
  timer = null;
  if (!p) return;
  useUndoStore.setState({ pending: null });
  unhide(p.id);
}
