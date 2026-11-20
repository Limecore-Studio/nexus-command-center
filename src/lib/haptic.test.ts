import { describe, it, expect, beforeEach, vi } from 'vitest';

// v1.22 (limecore#130) — haptics confirm the user's own action, on Android
// only; the plugin loads on first use.

const native = vi.hoisted(() => ({ on: true }));
const calls = vi.hoisted(() => [] as string[]);
vi.mock('@capacitor/core', async (orig) => ({
  ...(await orig<typeof import('@capacitor/core')>()),
  Capacitor: { isNativePlatform: () => native.on, getPlatform: () => (native.on ? 'android' : 'web') },
}));
vi.mock('@capacitor/haptics', () => ({
  ImpactStyle: { Light: 'LIGHT' },
  NotificationType: { Success: 'SUCCESS', Warning: 'WARNING' },
  Haptics: {
    impact: async ({ style }: { style: string }) => void calls.push(`impact:${style}`),
    notification: async ({ type }: { type: string }) => void calls.push(`notification:${type}`),
  },
}));

const { haptic } = await import('./haptic');
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  calls.length = 0;
  native.on = true;
});

describe('haptic', () => {
  it('maps light, success and warning to the plugin', async () => {
    haptic.light();
    haptic.success();
    haptic.warning();
    await settle();
    expect(calls).toEqual(['impact:LIGHT', 'notification:SUCCESS', 'notification:WARNING']);
  });

  it('does nothing on web or desktop', async () => {
    native.on = false;
    haptic.light();
    await settle();
    expect(calls).toEqual([]);
  });
});
