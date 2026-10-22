import { describe, it, expect, beforeEach, vi } from 'vitest';

// v1.18.1 (NCC#169) — taps and actions taken while NCC is closed are queued
// natively (persisted, each with a seq) and handed to JS by a drain. Every
// queued action is applied once, oldest first, and acknowledged only after.
//
// The applied-seq sets live for the module's lifetime, as they do in the
// app, so each test uses its own seqs.

type Listener = (event: any) => void;
const plugin = vi.hoisted(() => ({
  listeners: {} as Record<string, Listener>,
  pendingTap: { route: '' } as Record<string, unknown>,
  pendingAction: { actionId: '', route: '', extraJson: '' } as Record<string, unknown>,
  ackPendingTaps: vi.fn(async (_spec: { seqs: number[] }) => {}),
  ackPendingActions: vi.fn(async (_spec: { seqs: number[] }) => {}),
}));

vi.mock('@capacitor/core', async (orig) => ({
  ...(await orig<typeof import('@capacitor/core')>()),
  Capacitor: { isNativePlatform: () => true, getPlatform: () => 'android' },
}));
vi.mock('./nexusNotificationsPlugin', () => ({
  NexusNotifications: {
    addListener: async (name: string, fn: Listener) => {
      plugin.listeners[name] = fn;
      return { remove: () => {} };
    },
    consumePendingTap: async () => plugin.pendingTap,
    consumePendingAction: async () => plugin.pendingAction,
    ackPendingTaps: plugin.ackPendingTaps,
    ackPendingActions: plugin.ackPendingActions,
  },
}));
vi.mock('../store/useSettingsStore', () => ({
  useSettingsStore: { getState: () => ({ loaded: true, notifMasterEnabled: true }) },
}));

const {
  onNotificationAction,
  onNotificationTap,
  queuedActions,
  queuedTaps,
  TAP_MAX_AGE_MS,
  DONE_ACTION_MAX_AGE_MS,
} = await import('./notifications');

interface Queued {
  seq: number;
  actionId: string;
  route: string;
  extraJson: string;
  at: number;
}

function action(seq: number, taskId: string, at = Date.now()): Queued {
  return { seq, actionId: 'done', route: '/tasks', extraJson: JSON.stringify({ taskId }), at };
}

function view(seq: number, route: string, at = Date.now()): Queued {
  return { seq, actionId: 'view', route, extraJson: '', at };
}

function queueActions(...items: Queued[]) {
  plugin.pendingAction = { actionId: items[0]?.actionId ?? '', route: '', extraJson: '', actions: items };
}

const ackedActions = () => plugin.ackPendingActions.mock.calls.flatMap((c) => c[0].seqs);

beforeEach(() => {
  plugin.listeners = {};
  plugin.pendingTap = { route: '', taps: [] };
  plugin.pendingAction = { actionId: '', route: '', extraJson: '', actions: [] };
  plugin.ackPendingTaps.mockClear();
  plugin.ackPendingActions.mockClear();
});

describe('draining queued actions', () => {
  it('applies every queued action once, oldest first, each awaited, then acknowledges them', async () => {
    queueActions(action(1, 'a'), action(2, 'b'), action(3, 'c'));
    const log: string[] = [];
    await onNotificationAction(async ({ extra }) => {
      log.push(`start ${extra?.taskId}`);
      await new Promise((r) => setTimeout(r, 5));
      log.push(`end ${extra?.taskId}`);
      // Nothing is acknowledged while an action is still being applied.
      expect(plugin.ackPendingActions).not.toHaveBeenCalled();
    });
    expect(log).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
    expect(plugin.ackPendingActions).toHaveBeenCalledTimes(1);
    expect(ackedActions()).toEqual([1, 2, 3]);
  });

  it('does not apply an action twice when a second subscription finds it still queued', async () => {
    // The ack did not land (or has not yet), so the queue still holds both.
    queueActions(action(11, 'a'), action(12, 'b'));
    const handler = vi.fn();
    await onNotificationAction(handler);
    await onNotificationAction(handler);
    expect(handler.mock.calls.map(([p]) => p.extra.taskId)).toEqual(['a', 'b']);
    // Both drains acknowledge (the second, what was handled before), so the
    // queue empties whichever ack lands.
    expect(ackedActions()).toEqual([11, 12, 11, 12]);
  });

  it('does not apply a live action again when the drain also finds it', async () => {
    const handler = vi.fn();
    await onNotificationAction(handler);
    plugin.listeners.notificationAction({ ...action(21, 'a') });
    queueActions(action(21, 'a'), action(22, 'b'));
    await onNotificationAction(handler);
    expect(handler.mock.calls.map(([p]) => p.extra.taskId)).toEqual(['a', 'b']);
  });

  it('does not apply a drained action again when it then arrives live', async () => {
    queueActions(action(31, 'a'));
    const handler = vi.fn();
    await onNotificationAction(handler);
    plugin.listeners.notificationAction({ ...action(31, 'a') });
    await vi.waitFor(() => expect(ackedActions()).toEqual([31, 31]));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('keeps going past an action whose handler throws, and acknowledges it too', async () => {
    queueActions(action(41, 'bad'), action(42, 'good'));
    const applied: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await onNotificationAction(({ extra }) => {
      if (extra?.taskId === 'bad') throw new Error('boom');
      applied.push(String(extra?.taskId));
    });
    warn.mockRestore();
    expect(applied).toEqual(['good']);
    expect(ackedActions()).toEqual([41, 42]);
  });

  it('leaves an action the live path is still applying to the live path to acknowledge', async () => {
    let finish: () => void = () => {};
    const handler = vi.fn(
      ({ extra }: { extra: Record<string, unknown> | null }) =>
        extra?.taskId === 'slow' ? new Promise<void>((r) => (finish = r)) : undefined,
    );
    await onNotificationAction(handler);
    plugin.listeners.notificationAction({ ...action(91, 'slow') }); // still applying
    queueActions(action(91, 'slow'), action(92, 'b'));
    await onNotificationAction(handler);
    expect(ackedActions()).toEqual([92]);
    finish();
    await vi.waitFor(() => expect(ackedActions()).toEqual([92, 91]));
    expect(handler.mock.calls.map(([p]) => p.extra?.taskId)).toEqual(['slow', 'b']);
  });

  it('follows only the newest fresh navigation, and applies every "done"', async () => {
    const now = Date.now();
    queueActions(
      view(101, '/finance/budgets?cat=old', now - TAP_MAX_AGE_MS - 1),
      action(102, 'a', now - 3000),
      view(103, '/finance/budgets?cat=1', now - 2000),
      view(104, '/finance/budgets?cat=2', now - 1000),
      action(105, 'b', now),
    );
    const handler = vi.fn();
    await onNotificationAction(handler);
    expect(handler.mock.calls.map(([p]) => [p.actionId, p.actionId === 'done' ? p.extra?.taskId : p.route])).toEqual([
      ['done', 'a'],
      ['view', '/finance/budgets?cat=2'],
      ['done', 'b'],
    ]);
    expect(ackedActions()).toEqual([101, 102, 103, 104, 105]);
  });

  it('does not apply a "done" queued more than a week ago, and acknowledges it', async () => {
    queueActions(action(111, 'old', Date.now() - DONE_ACTION_MAX_AGE_MS - 1), action(112, 'recent'));
    const handler = vi.fn();
    await onNotificationAction(handler);
    expect(handler.mock.calls.map(([p]) => p.extra?.taskId)).toEqual(['recent']);
    expect(ackedActions()).toEqual([111, 112]);
  });

  it('applies a live action with no seq (not queued natively) and acknowledges nothing', async () => {
    const handler = vi.fn();
    await onNotificationAction(handler);
    plugin.listeners.notificationAction({ actionId: 'done', route: '', extraJson: '{"taskId":"x"}', seq: -1 });
    plugin.listeners.notificationAction({ actionId: 'done', route: '', extraJson: '{"taskId":"x"}', seq: -1 });
    await new Promise((r) => setTimeout(r, 0));
    expect(handler).toHaveBeenCalledTimes(2);
    expect(plugin.ackPendingActions).not.toHaveBeenCalled();
  });
});

describe('draining queued taps', () => {
  it('follows only the newest fresh tap, and acknowledges them all', async () => {
    const now = Date.now();
    plugin.pendingTap = {
      route: '/review',
      taps: [
        { seq: 51, route: '/tasks', at: now - 2000 },
        { seq: 52, route: '/habits', at: now - 1000 },
        { seq: 53, route: '//evil.example', at: now },
      ],
    };
    const onOpen = vi.fn();
    await onNotificationTap(onOpen);
    expect(onOpen.mock.calls).toEqual([['/habits']]);
    expect(plugin.ackPendingTaps).toHaveBeenCalledWith({ seqs: [51, 52, 53] });
  });

  it('does not follow a tap queued long ago, from a launch whose process died', async () => {
    plugin.pendingTap = { route: '/tasks', taps: [{ seq: 61, route: '/tasks', at: Date.now() - TAP_MAX_AGE_MS - 1 }] };
    const onOpen = vi.fn();
    await onNotificationTap(onOpen);
    expect(onOpen).not.toHaveBeenCalled();
    expect(plugin.ackPendingTaps).toHaveBeenCalledWith({ seqs: [61] });
  });

  it('does not follow a tap twice, live and then from the queue', async () => {
    const onOpen = vi.fn();
    await onNotificationTap(onOpen);
    plugin.listeners.notificationTap({ route: '/tasks', seq: 71 });
    plugin.pendingTap = { route: '/tasks', taps: [{ seq: 71, route: '/tasks', at: Date.now() }] };
    await onNotificationTap(onOpen);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});

describe('reading a drain result', () => {
  it('takes the queue when there is one', () => {
    const a = action(81, 'a');
    expect(queuedActions({ actionId: 'done', route: '', extraJson: '', actions: [a] })).toEqual([a]);
    expect(queuedTaps({ route: '/x', taps: [] })).toEqual([]);
  });

  it('reads the old single-slot shape as one entry without a seq', () => {
    expect(queuedActions({ actionId: 'view', route: '/finance', extraJson: '' })).toEqual([
      { seq: -1, actionId: 'view', route: '/finance', extraJson: '' },
    ]);
    expect(queuedActions({ actionId: '', route: '', extraJson: '' })).toEqual([]);
    expect(queuedTaps({ route: '/tasks' })).toEqual([{ seq: -1, route: '/tasks' }]);
    expect(queuedTaps({ route: '' })).toEqual([]);
    expect(queuedTaps(null)).toEqual([]);
  });
});
