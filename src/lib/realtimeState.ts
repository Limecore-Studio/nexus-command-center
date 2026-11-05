// v1.20 (NCC#221) — what the live-sync channel is actually doing, for
// Settings › Sync. Kept apart from realtime.ts so the panel can read it
// without loading the engine, which is fetched only once a user is signed in.
import { useSyncExternalStore } from 'react';

export type RealtimeState = 'off' | 'connecting' | 'live' | 'down';

let state: RealtimeState = 'off';
const listeners = new Set<() => void>();

export function setRealtimeState(next: RealtimeState): void {
  if (next === state) return;
  state = next;
  for (const l of listeners) l();
}

export function getRealtimeState(): RealtimeState {
  return state;
}

export function subscribeRealtimeState(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useRealtimeState(): RealtimeState {
  return useSyncExternalStore(subscribeRealtimeState, getRealtimeState, getRealtimeState);
}
