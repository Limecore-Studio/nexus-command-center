import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// v1.18.1 — account switch: the adoption choice comes first. A kept another
// account's (or a guest's) data on the device and B signed in: B answers Keep
// or Discard (or signs out) before the app shows any of it, with no
// "Decide later". Real Dexie (fake-indexeddb), stand-in Supabase.

const h = vi.hoisted(() => ({
  reads: 0,
  read: null as null | (() => Promise<unknown>),
  upsertError: null as null | { message: string },
}));
vi.mock('./supabase', () => ({
  supabase: {
    auth: { signOut: async () => ({ error: null }) },
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => {
            h.reads++;
            return h.read!();
          },
        }),
      }),
      upsert: async () => ({ error: h.upsertError }),
    }),
  },
  readStoredSession: async () => null,
  clearStoredSession: async () => {},
}));
vi.mock('./ssoPublisher', () => ({ publishSession: async () => {}, clearPublishedSession: async () => {} }));
vi.mock('./originMarker', () => ({ scheduleOriginStamp: () => {} }));
vi.mock('./guestMode', () => ({ setGuestMode: async () => {}, isGuestModeKnown: () => false }));
vi.stubGlobal('window', { dispatchEvent: () => true, addEventListener: () => {}, removeEventListener: () => {} });

const { db } = await import('../db/database');
const { evaluateAdoption, readLastUserId, LAST_USER_KEY } = await import('./adoptionChoice');
const { keepLocalData, discardLocalData } = await import('./adoptionAnswer');
const { adoptionClearFor, setAdoptionStatus, exportAllowed, useAdoptionGate } = await import('./adoptionGate');
const { downloadExport } = await import('./dataRights');
const { readDecided, writeDecided } = await import('./adoptionFlag');
const { useSessionStore } = await import('../store/useSessionStore');

type Item = Parameters<typeof db.syncQueue.add>[0];
const queued = (id: string, owner: string | null): Item => ({
  id, entityType: 'task', entityId: id, operation: 'update', payload: '{}',
  createdAt: '2026-10-17T00:00:00Z', owner,
});
const task = (id: string, syncStatus: 'synced' | 'pending') =>
  ({ id, title: id, priority: 'low', completed: false, syncStatus, createdAt: '', updatedAt: '' }) as never;

const offline = () => {
  h.read = async () => ({ data: null, error: { message: 'Failed to fetch' } });
  h.upsertError = { message: 'Failed to fetch' };
};

// A signed out choosing Keep: A's rows (already synced) stay, and A was the
// last account to answer here.
async function keptByA(a: string) {
  await db.tasks.add(task(`${a}-task`, 'synced'));
  localStorage.setItem(LAST_USER_KEY, a);
  writeDecided(a, 'synced');
}

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
  localStorage.clear();
  h.reads = 0;
  h.read = async () => ({ data: { ncc_local_data_prompt_dismissed: true }, error: null });
  h.upsertError = null;
});

describe('an account switch over kept data', () => {
  it('asks B, even when B answered before on this device and in the cloud', async () => {
    await keptByA('a1');
    writeDecided('b1', 'synced'); // an earlier answer of B's (e.g. a dismissal)
    expect(await evaluateAdoption('b1')).toBe('ask');
    // Decided on the device alone: neither flag is read on a switch.
    expect(h.reads).toBe(0);
  });

  it('asks offline (an unverified session) without the network', async () => {
    offline();
    await keptByA('a2');
    expect(await evaluateAdoption('b2')).toBe('ask');
    expect(h.reads).toBe(0);
  });

  it('does not ask A when A comes back', async () => {
    await keptByA('a3');
    expect(await evaluateAdoption('a3')).toBe('clear');
  });

  it('asks about a guest\'s edits, whoever the last account was', async () => {
    writeDecided('b4', 'synced');
    localStorage.setItem(LAST_USER_KEY, 'b4');
    await db.syncQueue.add(queued('g', null));
    expect(await evaluateAdoption('b4')).toBe('ask');
  });

  it('A\'s own pre-sign-in data opens the app while the cloud is asked', async () => {
    localStorage.setItem(LAST_USER_KEY, 'a5');
    await db.tasks.add(task('t5', 'pending'));
    h.read = async () => ({ data: null, error: null }); // not answered yet
    const own = vi.fn();
    expect(await evaluateAdoption('a5', own)).toBe('ask');
    expect(own).toHaveBeenCalledOnce();
    // Never on an account switch.
    await keptByA('a6');
    const other = vi.fn();
    await evaluateAdoption('b6', other);
    expect(other).not.toHaveBeenCalled();
  });
});

describe('an account\'s own data, pulled after the app opened', () => {
  it('an empty device opens at once and is this account\'s from then on, even with the cloud unreachable', async () => {
    offline();
    localStorage.setItem(LAST_USER_KEY, 'x14'); // an earlier account, nothing of it left
    expect(await evaluateAdoption('a14')).toBe('clear');
    expect(h.reads).toBe(0); // no wait on the flag read
    expect(readLastUserId()).toBe('a14');
    // A's pull lands; the `online` re-check and the next launch do not ask A.
    await db.tasks.add(task('a14-pulled', 'synced'));
    expect(await evaluateAdoption('a14')).toBe('clear');
    h.read = async () => ({ data: null, error: null });
    expect(await evaluateAdoption('a14')).toBe('clear');
  });

  it('a cloud read that fails records the account too, so its rows never count as someone else\'s', async () => {
    h.read = async () => ({ data: null, error: { message: 'Failed to fetch' } });
    await db.tasks.add(task('t15', 'pending')); // a guest's, with no queued edits
    expect(await evaluateAdoption('a15')).toBe('clear');
    expect(readLastUserId()).toBe('a15');
    await db.tasks.add(task('a15-pulled', 'synced'));
    expect(await evaluateAdoption('a15')).toBe('clear');
  });
});

describe('no "Decide later"', () => {
  it('the prompt offers Keep, Discard and Sign out only, in every locale', () => {
    const src = readFileSync(join(__dirname, '../components/AdoptionPrompt.tsx'), 'utf8');
    expect(src).not.toMatch(/adoption\.later|onLater|deferred/);
    expect(src).toMatch(/adoption\.keep/);
    expect(src).toMatch(/adoption\.discard/);
    expect(src).toMatch(/settings\.signOut/);
    const dir = join(__dirname, '../i18n/locales');
    const locales = readdirSync(dir).filter((f) => f.endsWith('.json'));
    expect(locales).toHaveLength(10);
    for (const f of locales) {
      const json = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      expect(json.adoption.later, f).toBeUndefined();
      expect(typeof json.settings.signOut, f).toBe('string');
      // The account-switch wording.
      expect(typeof json.adoption.switchBody, f).toBe('string');
      expect(typeof json.adoption.switchFooter, f).toBe('string');
    }
  });

  it('nothing stored from an earlier launch lets B skip the question', async () => {
    await keptByA('a7');
    // Everything an older build could have left behind for B.
    writeDecided('b7', 'pending');
    h.read = async () => ({ data: { ncc_local_data_prompt_dismissed: true }, error: null });
    expect(await evaluateAdoption('b7')).toBe('ask');
    expect(await evaluateAdoption('b7')).toBe('ask'); // and again next launch
  });
});

describe('the gate', () => {
  it('stays shut for B until B answers, and opens only for B', async () => {
    await keptByA('a8');
    setAdoptionStatus('b8', await evaluateAdoption('b8'));
    expect(adoptionClearFor('b8')).toBe(false);
    expect(adoptionClearFor('a8')).toBe(false);
    await keepLocalData('b8');
    expect(adoptionClearFor('b8')).toBe(true);
    expect(adoptionClearFor('a8')).toBe(false);
  });

  it('a check still waiting on the cloud when the answer lands does not ask again', async () => {
    localStorage.setItem(LAST_USER_KEY, 'u9');
    await db.tasks.add(task('t9', 'pending'));
    let answer!: (v: unknown) => void;
    h.read = () => new Promise((r) => (answer = r));
    const pending = evaluateAdoption('u9');
    await vi.waitFor(() => expect(h.reads).toBe(1));
    await keepLocalData('u9');
    answer({ data: null, error: null });
    expect(await pending).toBe('clear');
  });
});

describe('Keep and Discard', () => {
  it('Keep adopts into B: unsynced rows and a guest\'s edits are queued for B; B is not asked again', async () => {
    await keptByA('a10');
    await db.tasks.add(task('pending-row', 'pending'));
    await db.syncQueue.add(queued('guest-edit', null));
    await keepLocalData('b10');
    const owners = Object.fromEntries((await db.syncQueue.toArray()).map((q) => [q.entityId, q.owner]));
    expect(owners).toEqual({ 'pending-row': 'b10', 'guest-edit': 'b10' });
    expect(await db.tasks.count()).toBe(2); // the rows stay on the device
    expect(readLastUserId()).toBe('b10');
    expect(await evaluateAdoption('b10')).toBe('clear');
  });

  it('Keep works offline: the answer is remembered on the device until the cloud has it', async () => {
    offline();
    await keptByA('a11');
    await keepLocalData('b11');
    expect(readDecided('b11')).toBe('pending');
    expect(adoptionClearFor('b11')).toBe(true);
  });

  it('Discard wipes the device, offline too, and the gate stays shut until the reload', async () => {
    offline();
    await keptByA('a12');
    await db.syncQueue.add(queued('a-edit', 'a12'));
    setAdoptionStatus('b12', 'ask');
    await discardLocalData('b12');
    for (const t of db.tables) expect(await t.count(), t.name).toBe(0);
    expect(adoptionClearFor('b12')).toBe(false);
    expect(readLastUserId()).toBe('b12');
    expect(readDecided('b12')).toBe('pending');
    expect(await evaluateAdoption('b12')).toBe('clear');
  });
});

describe('Sign out from the prompt', () => {
  it('leaves A\'s data and A\'s unsynced edits as they were; A is not asked, B is asked again', async () => {
    await keptByA('a13');
    await db.syncQueue.add(queued('a-edit', 'a13'));
    useSessionStore.setState({ user: { id: 'b13' } as never, initialized: true });
    expect(await evaluateAdoption('b13')).toBe('ask');
    await useSessionStore.getState().signOut();
    expect(await db.tasks.get('a13-task')).toBeTruthy();
    expect((await db.syncQueue.toArray()).map((q) => [q.id, q.owner])).toEqual([['a-edit', 'a13']]);
    expect(readLastUserId()).toBe('a13');
    expect(await evaluateAdoption('a13')).toBe('clear');
    expect(await evaluateAdoption('b13')).toBe('ask');
  });
});

describe('export before the choice', () => {
  it('is refused while an account has not answered, or its state is unknown', async () => {
    useAdoptionGate.setState({ userId: null, status: 'checking' });
    expect(exportAllowed(null)).toBe(true); // a guest launch: no account seen
    expect(exportAllowed('b16')).toBe(false); // signed in, not worked out yet
    setAdoptionStatus('b16', 'ask');
    expect(exportAllowed('b16')).toBe(false);
    expect(exportAllowed(null)).toBe(false); // the crash screen could not tell who
    await expect(downloadExport({ id: 'b16' })).rejects.toThrow(/adoption choice pending/);
    await expect(downloadExport(null)).rejects.toThrow(/adoption choice pending/);
    setAdoptionStatus('b16', 'checking');
    expect(exportAllowed('b16')).toBe(false);
    setAdoptionStatus('b16', 'clear');
    expect(exportAllowed('b16')).toBe(true);
    expect(exportAllowed('a16')).toBe(false);
  });

  it('the crash screen hides "Export my data" by the same rule', () => {
    const src = readFileSync(join(__dirname, '../components/ErrorBoundary.tsx'), 'utf8');
    expect(src).toMatch(/\{exportAllowed\(useAdoptionGate\.getState\(\)\.userId\) && \(\s*<button[^>]*onClick=\{this\.exportData\}/);
    // The same rule as exportAllowed(null) for no account, and the gate for one.
    useAdoptionGate.setState({ userId: null, status: 'checking' });
    expect(exportAllowed(useAdoptionGate.getState().userId)).toBe(true);
    setAdoptionStatus('b17', 'ask');
    expect(exportAllowed(useAdoptionGate.getState().userId)).toBe(false);
  });

  it('a prompt that fails to load shows Retry and Sign out, inside its own boundary', () => {
    const src = readFileSync(join(__dirname, '../App.tsx'), 'utf8');
    expect(src).toMatch(/<SheetBoundary onFail=\{\(\) => setPromptFailed\(true\)\}>\s*<Suspense fallback=\{splash\}>\s*<AdoptionPrompt \/>/);
    expect(src).toMatch(/setAdoptionPrompt\(\(\) => lazy\(loadAdoptionPrompt\)\)/); // a fresh lazy() on Retry
    expect(src).toMatch(/t\('common\.retry'\)[\s\S]{0,400}t\('settings\.signOut'\)/);
  });
});
