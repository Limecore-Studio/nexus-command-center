// v1.22 (limecore#130) — haptic feedback, by the suite's policy: it confirms
// the user's own action and never interrupts.
//   light()   — a toggle, checking off a task or habit, a Quick Log save
//   success() — marking a goal complete
//   warning() — confirming a destructive action
// Nothing on scroll, page loads, sync or any other background event. The OS
// "touch feedback" setting is respected by the plugin (a no-op when off).
// Android only; the plugin's JS loads on first use, outside the startup bundle,
// and every call is fire-and-forget.
import { Capacitor } from '@capacitor/core';

type HapticsModule = typeof import('@capacitor/haptics');
let mod: Promise<HapticsModule> | null = null;
const load = () => (mod ??= import('@capacitor/haptics'));

// Every call chains onto this, so tests can wait for the lazy import and the
// calls to finish (hapticSettled) instead of guessing a delay.
let settled: Promise<void> = Promise.resolve();

function run(fn: (m: HapticsModule) => Promise<void>): void {
  if (!Capacitor.isNativePlatform()) return;
  const call = load()
    .then(fn)
    .catch(() => {
      /* no vibrator, or the plugin is unavailable: feedback is optional */
    });
  settled = settled.then(() => call);
}

/** Test seam: resolves once every haptic call made so far has finished. */
export function hapticSettled(): Promise<void> {
  return settled;
}

export const haptic = {
  light: () => run((m) => m.Haptics.impact({ style: m.ImpactStyle.Light })),
  success: () => run((m) => m.Haptics.notification({ type: m.NotificationType.Success })),
  warning: () => run((m) => m.Haptics.notification({ type: m.NotificationType.Warning })),
};
