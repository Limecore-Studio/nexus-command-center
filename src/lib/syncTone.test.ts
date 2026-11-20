import { describe, it, expect, vi } from 'vitest';

vi.mock('./supabase', () => ({ supabase: {} }));

const { syncTone } = await import('./syncTone');

// v1.22 (NCC#290) — the header dot is hidden while all is well.
const base = { signedIn: true, isOnline: true, pendingCount: 0, lastError: null as string | null, conversion: false };

describe('syncTone', () => {
  it('hidden when synced and idle, and always for a guest', () => {
    expect(syncTone(base)).toBe('ok');
    expect(syncTone({ ...base, signedIn: false, isOnline: false, pendingCount: 3, lastError: 'Not signed in.' })).toBe('ok');
  });

  it('amber while writes wait or the device is offline', () => {
    expect(syncTone({ ...base, pendingCount: 2 })).toBe('pending');
    expect(syncTone({ ...base, isOnline: false })).toBe('pending');
  });

  it('red when the last sync failed or a conversion is waiting', () => {
    expect(syncTone({ ...base, lastError: '1 item(s) failed to upload.', pendingCount: 1 })).toBe('failed');
    expect(syncTone({ ...base, conversion: true })).toBe('failed');
  });
});
