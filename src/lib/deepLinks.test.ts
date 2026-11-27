import { describe, it, expect, beforeEach } from 'vitest';
import { parseDeepLink, queueDeepLink, takeDeepLink } from './deepLinks';

// v1.22 (limecore#127) — launcher shortcuts open com.limecore.nexus://open/<route>.

beforeEach(() => {
  takeDeepLink();
});

describe('parseDeepLink', () => {
  it('knows the three shortcut targets', () => {
    expect(parseDeepLink('com.limecore.nexus://open/expense')).toEqual({ kind: 'route', path: '/finance/add' });
    expect(parseDeepLink('com.limecore.nexus://open/quicklog')).toEqual({ kind: 'quickLog' });
    expect(parseDeepLink('com.limecore.nexus://open/tasks/')).toEqual({ kind: 'route', path: '/tasks' });
  });

  it('ignores anything else: the sign-in callback, unknown routes, other schemes, paths', () => {
    expect(parseDeepLink('com.limecore.nexus://login-callback?code=x')).toBeNull();
    expect(parseDeepLink('com.limecore.nexus://open/settings')).toBeNull();
    expect(parseDeepLink('com.studydesk.app://open/tasks')).toBeNull();
    expect(parseDeepLink('com.limecore.nexus://open/tasks/../settings')).toBeNull();
  });
});

describe('pending link', () => {
  it('is held until the shell takes it, once', () => {
    expect(queueDeepLink('com.limecore.nexus://open/tasks')).toBe(true);
    expect(takeDeepLink()).toEqual({ kind: 'route', path: '/tasks' });
    expect(takeDeepLink()).toBeNull();
  });

  it('an unknown link is not queued', () => {
    expect(queueDeepLink('com.limecore.nexus://open/nope')).toBe(false);
    expect(takeDeepLink()).toBeNull();
  });
});
