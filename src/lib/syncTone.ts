// v1.22 (NCC#290) — what the header's sync dot shows (components/SyncDot).

export type SyncTone = 'ok' | 'pending' | 'failed';

/** Hidden ('ok') while all is well; 'pending' while writes wait or the device
 *  is offline; 'failed' when the last sync failed or a currency conversion is
 *  waiting. A guest has nothing to sync, so nothing to show. */
export function syncTone(s: { signedIn: boolean; isOnline: boolean; pendingCount: number; lastError: string | null; conversion: boolean }): SyncTone {
  if (!s.signedIn) return 'ok';
  if (s.lastError || s.conversion) return 'failed';
  if (!s.isOnline || s.pendingCount > 0) return 'pending';
  return 'ok';
}
