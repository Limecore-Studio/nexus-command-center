import { describe, it, expect, beforeEach } from 'vitest';

// v1.16 (#48) — the F-Droid update check, ported from StudyDesk#67. The HTTP
// client, the app info and the platform are injected.

// src/test/setup.ts provides an in-memory localStorage; each case clears it.

const { checkFdroidUpdate, setUpdateCheckEnabled, dismissUpdate, resetFdroidUpdateForTests } = await import('./fdroidUpdate');

const NOW = Date.parse('2026-09-25T12:00:00Z');
const HOUR = 60 * 60 * 1000;

/** An F-Droid API stand-in that records every request. */
function fdroid(body: unknown, { status = 200, fail = false } = {}) {
  const calls: string[] = [];
  return {
    calls,
    get: async (opts: { url: string }) => {
      calls.push(opts.url);
      if (fail) throw new Error('offline');
      return { status, data: body };
    },
  };
}
const answer = (code: number, name: string) => ({
  packageName: 'com.limecore.nexus',
  suggestedVersionCode: code,
  packages: [{ versionName: name, versionCode: code }, { versionName: '1.12.1', versionCode: 34 }],
});
const app = { getInfo: async () => ({ version: '1.12.1', build: '34' }) };
const run = (http: ReturnType<typeof fdroid>, over: Record<string, unknown> = {}) =>
  checkFdroidUpdate({ now: NOW, http, app, platform: 'android', ...over });

// v1.21.1 (limecore#87): the check is opt-in. Most cases run as an owner
// (the guest here) who said yes; the consent cases below start unasked.
const { setConsent } = await import('./usageConsent');
function clearButConsent() {
  localStorage.clear();
  setConsent('updateCheck', true);
}

beforeEach(() => {
  clearButConsent();
  resetFdroidUpdateForTests();
});

describe('checkFdroidUpdate', () => {
  it('announces a newer F-Droid build, with both version names', async () => {
    const http = fdroid(answer(38, '1.15.1'));
    expect(await run(http)).toEqual({ current: { code: 34, name: '1.12.1' }, latest: { code: 38, name: '1.15.1' } });
    expect(http.calls).toEqual(['https://f-droid.org/api/v1/packages/com.limecore.nexus']);
  });

  it('says nothing when this build is current or newer', async () => {
    expect(await run(fdroid(answer(34, '1.12.1')))).toBeNull();
    clearButConsent();
    expect(await run(fdroid(answer(33, '1.12.0')))).toBeNull();
  });

  it('asks F-Droid at most once a day', async () => {
    const http = fdroid(answer(38, '1.15.1'));
    await run(http);
    expect(await run(http, { now: NOW + 23 * HOUR })).not.toBeNull();
    expect(http.calls).toHaveLength(1);
    await run(http, { now: NOW + 25 * HOUR });
    expect(http.calls).toHaveLength(2);
  });

  it('a failed request is silent and still counts against the day', async () => {
    expect(await run(fdroid(null, { fail: true }))).toBeNull();
    const up = fdroid(answer(38, '1.15.1'));
    expect(await run(up, { now: NOW + HOUR })).toBeNull();
    expect(up.calls).toHaveLength(0);
  });

  it('is silent on an HTTP error or a malformed answer', async () => {
    expect(await run(fdroid(answer(38, 'x'), { status: 404 }))).toBeNull();
    clearButConsent();
    expect(await run(fdroid({ suggestedVersionCode: 'soon' }))).toBeNull();
    clearButConsent();
    expect(await run(fdroid('not json'))).toBeNull();
  });

  it('accepts the body as a JSON string, as the native client may return it', async () => {
    expect(await run(fdroid(JSON.stringify(answer(38, '1.15.1'))))).not.toBeNull();
  });

  it('never runs off Android', async () => {
    for (const platform of ['web', 'electron', 'ios']) {
      const http = fdroid(answer(38, '1.15.1'));
      expect(await run(http, { platform })).toBeNull();
      expect(http.calls).toHaveLength(0);
    }
  });
});

describe('the Settings switch', () => {
  it('off means no request at all, not just no notice', async () => {
    setUpdateCheckEnabled(false);
    const http = fdroid(answer(38, '1.15.1'));
    expect(await run(http)).toBeNull();
    expect(http.calls).toHaveLength(0);
  });

  it('turning it off forgets the answer, so turning it on asks afresh', async () => {
    await run(fdroid(answer(38, '1.15.1')));
    setUpdateCheckEnabled(false);
    expect(localStorage.getItem('nexus.fdroidLast')).toBeNull();
    setUpdateCheckEnabled(true);
    const http = fdroid(answer(38, '1.15.1'));
    expect(await run(http)).not.toBeNull();
    expect(http.calls).toHaveLength(1);
  });

  it('survives a restart: the off setting is stored', async () => {
    setUpdateCheckEnabled(false);
    resetFdroidUpdateForTests();
    const http = fdroid(answer(38, '1.15.1'));
    expect(await run(http)).toBeNull();
    expect(http.calls).toHaveLength(0);
  });
});

describe('dismissal', () => {
  it('hides that version, and the next version is announced again', async () => {
    await run(fdroid(answer(38, '1.15.1')));
    dismissUpdate();
    expect(await run(fdroid(answer(38, '1.15.1')), { now: NOW + 25 * HOUR })).toBeNull();
    expect(await run(fdroid(answer(39, '1.16.0')), { now: NOW + 50 * HOUR })).toEqual({
      current: { code: 34, name: '1.12.1' },
      latest: { code: 39, name: '1.16.0' },
    });
  });
});

describe('consent (limecore#87)', () => {
  it('not asked means no request: existing installs start off', async () => {
    localStorage.clear();
    localStorage.setItem('nexus.fdroidCheck', 'on'); // the old key is ignored
    resetFdroidUpdateForTests();
    const http = fdroid(answer(38, '1.15.1'));
    expect(await run(http)).toBeNull();
    expect(http.calls).toHaveLength(0);
  });

  it('is kept per owner: another owner on this device is not covered', async () => {
    setConsent('updateCheck', true, 'someone-else');
    localStorage.removeItem('nexus.consent.updateCheck.guest');
    const http = fdroid(answer(38, '1.15.1'));
    expect(await run(http)).toBeNull();
    expect(http.calls).toHaveLength(0);
  });
});
