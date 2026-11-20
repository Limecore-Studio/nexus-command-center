import { describe, it, expect, beforeEach, vi } from 'vitest';

// v1.22 (StudyDesk#260, NCC half) — the one-time "NCC on your computer" note.

const native = vi.hoisted(() => ({ on: true }));
vi.mock('@capacitor/core', async (orig) => ({
  ...(await orig<typeof import('@capacitor/core')>()),
  Capacitor: { isNativePlatform: () => native.on, getPlatform: () => (native.on ? 'android' : 'web') },
}));


const { computerNoteDue, dismissComputerNote } = await import('./computerApps');

const NOW = Date.parse('2026-11-19T12:00:00Z');
const user = (daysOld: number) => ({ id: 'u1', created_at: new Date(NOW - daysOld * 86_400_000).toISOString() });

beforeEach(() => {
  localStorage.clear();
  native.on = true;
});

describe('computerNoteDue', () => {
  it('shows once a synced account is over a week old, on the phone app', () => {
    expect(computerNoteDue(user(8), '2026-11-19T10:00:00Z', NOW)).toBe(true);
  });

  it('not in the first week, not before a sync, not on web or desktop', () => {
    expect(computerNoteDue(user(3), '2026-11-19T10:00:00Z', NOW)).toBe(false);
    expect(computerNoteDue(user(8), null, NOW)).toBe(false);
    native.on = false;
    expect(computerNoteDue(user(8), '2026-11-19T10:00:00Z', NOW)).toBe(false);
  });

  it('once per account: dismissed stays dismissed', () => {
    dismissComputerNote('u1');
    expect(computerNoteDue(user(8), '2026-11-19T10:00:00Z', NOW)).toBe(false);
    expect(computerNoteDue({ ...user(8), id: 'u2' }, '2026-11-19T10:00:00Z', NOW)).toBe(true);
  });
});
