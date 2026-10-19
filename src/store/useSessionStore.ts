// Wraps Supabase's auth state in a zustand store so React components can
// subscribe naturally.
//
// `loading` is true until the first getSession() call resolves — render a
// splash while it's true to avoid flashing the login screen for users with
// a valid session.
import { create } from 'zustand';
import { isAuthRetryableFetchError, type Session, type User } from '@supabase/supabase-js';
import { clearStoredSession, readStoredSession, supabase } from '../lib/supabase';
import { publishSession, clearPublishedSession } from '../lib/ssoPublisher';
import { isGuestModeKnown, setGuestMode } from '../lib/guestMode';
import { scheduleOriginStamp } from '../lib/originMarker';
import { db } from '../db/database';
import { claimUnowned, setQueueOwner } from '../db/syncQueue';
import { cancelAllReminders, setReminderAudience } from '../lib/notifications';

interface SessionState {
  session: Session | null;
  user: User | null;
  loading: boolean;
  initialized: boolean;
  /** v1.19 — NCC#135: true while the user on screen comes from the stored
   *  session because the server could not be asked (offline, expired access
   *  token). Cleared by the first real answer: a refresh, a sign-in or a
   *  sign-out. */
  sessionUnverified: boolean;
  init: () => Promise<void>;
  signOut: () => Promise<void>;
}

// Derive display name + initials from user metadata.
export function userDisplayName(user: User | null): string {
  if (!user) return '';
  const meta = user.user_metadata ?? {};
  return (
    (meta.full_name as string) ??
    (meta.name as string) ??
    user.email?.split('@')[0] ??
    ''
  );
}

export function userInitials(user: User | null): string {
  const name = userDisplayName(user);
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// v1.19 — NCC#135: how long cold start waits for getSession() before opening
// on the stored session. Online, an expired token refreshes well inside this;
// offline, it caps a wait that used to run 25–50 s.
const SESSION_HEAD_START_MS = 1500;
// How long sign-out waits for the server before signing out locally.
const SIGN_OUT_WAIT_MS = 3000;

export const useSessionStore = create<SessionState>((set) => ({
  session: null,
  user: null,
  loading: true,
  initialized: false,
  sessionUnverified: false,

  async init() {
    if (useSessionStore.getState().initialized) return;
    // v1.19 — NCC#135. The listener goes on FIRST, before anything can wait
    // on the network, so an answer that lands after cold start (a refresh
    // that finally succeeded, a sign-out the server asserted) is never missed.
    supabase.auth.onAuthStateChange((event, session) => {
      // Offline with an expired access token, supabase-js gives up refreshing
      // and still emits INITIAL_SESSION with a null session, although the
      // stored session (and its refresh token) is intact. That is "could not
      // ask", not "signed out": the old handler took it as a sign-out and
      // dropped the user onto Login mid-use. LimeLog has had this guard
      // (sessionUnverified) since v1.13; a real sign-out still arrives as
      // SIGNED_OUT and clears below.
      if (event === 'INITIAL_SESSION' && !session && useSessionStore.getState().sessionUnverified) {
        return;
      }
      // v1.18.1 (NCC#186) — a different account signing in over this one (the
      // OAuth deep link while signed in) emits SIGNED_IN with no SIGNED_OUT
      // first. Cancel before the new user is set, so nothing the old account
      // armed survives and its in-flight schedules are refused.
      const previousId = useSessionStore.getState().user?.id;
      if (event === 'SIGNED_IN' && session && previousId && previousId !== session.user.id) {
        void cancelAllReminders();
      }
      set({ session, user: session?.user ?? null, sessionUnverified: false });
      // v1.18.1 (NCC#186) — a sign-out NCC did not ask for (refresh token
      // revoked, the account deleted, auth-js giving up) leaves no reload
      // behind it, so the reminders of the account that just left would keep
      // firing on the Login screen. Our own signOut cancels too; twice is
      // harmless (the second finds nothing pending).
      if (event === 'SIGNED_OUT') void cancelAllReminders();
      scheduleOriginStamp(session?.user ?? null);
      // Republish on every auth change — token refreshes, sign-in,
      // sign-out (null clears the bridge for siblings). Fire-and-forget
      // here is fine — onAuthStateChange callbacks aren't awaited by
      // any caller, and the next event will republish if this one drops.
      void publishSession(session);
    });

    // getSession() answers from storage at once while the access token is
    // valid, and also when nobody is signed in. Only an EXPIRED token makes it
    // refresh first, and offline that refresh retries with backoff for ~25 s
    // (measured ~51 s for the full call with auth-js 2.105.4 and fetch
    // failing) — the 20–30 s "LOADING…" of NCC#135. So it gets a short head
    // start; past that, the app opens on the stored session and the real
    // answer settles in the background.
    const answer = supabase.auth.getSession().then(
      ({ data, error }) => ({ session: data.session, error }),
      (error: unknown) => ({ session: null, error }),
    );
    const first = await Promise.race([
      answer,
      new Promise<null>((res) => setTimeout(() => res(null), SESSION_HEAD_START_MS)),
    ]);

    if (first) {
      await applyAnswer(first.session, first.error);
      // v1.1.1 — BUG-1 fix: await the initial publish so the SSO bridge is
      // populated BEFORE init() returns. Eliminates the race where a sibling
      // app querying mid-init would see an empty cursor even though the user
      // has a valid restored session. The await adds a few ms to cold start
      // — acceptable trade for SSO reliability. Failures still swallowed
      // inside publishSession so the auth flow continues regardless.
      if (first.session || !first.error) await publishSession(first.session);
    } else {
      // Still refreshing: open on the account this device already has. The
      // stored token may be expired, but nothing in the UI uses it as a
      // credential (only user.id), and every request goes through supabase-js,
      // which waits for the refresh itself. The SSO bridge keeps what it last
      // published until the answer arrives.
      const stored = await readStoredSession();
      set({
        session: stored,
        user: stored?.user ?? null,
        sessionUnverified: !!stored,
        loading: false,
        initialized: true,
      });
      void answer.then(async ({ session, error }) => {
        await applyAnswer(session, error);
        if (session || !error) void publishSession(session);
      });
    }
    // ACT-5 — cover the restored-session path too, not just fresh sign-ins.
    // Every account that predates this instrumentation only ever appears here.
    scheduleOriginStamp(useSessionStore.getState().user);

    async function applyAnswer(session: Session | null, error: unknown) {
      if (session) {
        set({ session, user: session.user, sessionUnverified: false, loading: false, initialized: true });
        return;
      }
      // A network failure is "could not ask": keep the account on screen (or
      // the stored one, if the failure came back inside the head start)
      // rather than signing the user out offline. Anything else — nobody
      // stored, or a refresh token the server rejected — is a real answer.
      if (error && isAuthRetryableFetchError(error)) {
        const shown = useSessionStore.getState().session ?? (await readStoredSession());
        set({
          session: shown,
          user: shown?.user ?? null,
          sessionUnverified: !!shown,
          loading: false,
          initialized: true,
        });
        return;
      }
      set({ session: null, user: null, sessionUnverified: false, loading: false, initialized: true });
    }
  },

  async signOut() {
    // v1.4 — clear the SSO bridge BEFORE the auth round-trip so a
    // concurrent sibling query can't grab a token that's about to be
    // invalidated. onAuthStateChange's null fire will also clear, but
    // this closes the race window cleanly.
    await clearPublishedSession();
    // v1.18.1 (NCC#186) — cancel every scheduled reminder, Keep and Wipe
    // alike. They carry this account's task and habit titles and used to keep
    // firing after sign-out (and, with the boot re-arm, after a reboot). Done
    // first, so it is local and finished before the offline wait below, and
    // before anything that can fail. cancelAllReminders never throws and is
    // time-capped; the next sign-in's load re-arms (AppShell mount, habits
    // load, the post-sync task reconcile).
    await cancelAllReminders();
    // v1.2.1 — security audit finding FSG-2/FSG-6.
    //
    // Drain the unsynced syncQueue BEFORE clearing the session.
    //
    // Threat: A signs in, edits offline (queued in Dexie). A signs out
    // without first reconnecting. B signs in on the same device. App.tsx's
    // user-change useEffect kicks `syncNow()`, which calls
    // `pushQueue(B.userId)` — and every push handler stamps
    // `user_id: ctx.userId` from the LIVE session. A's queued edits would
    // land in B's cloud account under B's user_id. RLS doesn't help here
    // because B is genuinely the inserting user; the violation is one
    // semantic level above the database.
    //
    // Fix: delete every unsynced queue entry on sign-out. Synced entries
    // (rows with syncedAt set) are kept as harmless audit trail. The
    // user accepts that signing out abandons any unsynced offline edits —
    // a sharper trade-off than silently rewriting them to another account.
    //
    // Already-synced rows in Dexie (transactions, holdings, etc.) are
    // NOT cleared here. The AdoptionPrompt path (BUG-2) is the right UX
    // surface for "I see local data — adopt or discard?" on next sign-in.
    // The Medium follow-up (FSG-2b) is to re-fire that prompt when the
    // signed-in user_id changes across sessions, since the cloud
    // dismissed-flag is per-user and currently lets a returning B skip
    // adoption while A's data sits there.
    //
    // v1.18.1 (NCC#140): except this user's own edits. Every item now records
    // whose it is and only its owner pushes it (db/syncQueue.ts), so they can
    // no longer reach B; they stay, and go up the next time this account
    // signs in on this device. Deleting them lost every offline edit at
    // sign-out. Items with no owner (queued by an older build) still go:
    // those are the ones that could reach B.
    //
    // v1.18.1 — and another account's stay too. Only that account can push
    // them (pushableFor), so deleting them only lost its offline edits, e.g.
    // when B signs out from the "Existing data found" prompt over A's kept
    // data. A guest's (null) still go, as before.
    try {
      await db.syncQueue.filter((q) => !q.syncedAt && typeof q.owner !== 'string').delete();
    } catch (e) {
      console.warn('[auth] signOut: syncQueue drain failed:', (e as Error).message);
    }
    // v1.19 — NCC#141 review. Offline, auth-js's signOut first resolves the
    // session (an expired token means its refresh retry chain: ~75 s
    // measured), then its logout call fails on the network and it returns
    // WITHOUT removing the session — the user tapped Sign out and came back
    // signed in. Give it a few seconds; past that, or on any error, remove
    // the stored session here so the sign-out is real on this device.
    const outcome = await Promise.race([
      supabase.auth.signOut({ scope: 'local' }).then(
        ({ error }) => error ?? null,
        (error: unknown) => error,
      ),
      new Promise<'timeout'>((res) => setTimeout(() => res('timeout'), SIGN_OUT_WAIT_MS)),
    ]);
    if (outcome) {
      console.warn('[auth] signOut: server not reached, removing the local session:', outcome === 'timeout' ? 'timed out' : (outcome as Error).message);
      await clearStoredSession();
    }
    // v1.1 auth UX — clear the guest-mode flag so the next render lands
    // on the Login screen rather than back into a half-authenticated guest
    // state. App.tsx listens for the change event below.
    await setGuestMode(false);
    window.dispatchEvent(new CustomEvent('nexus:guest-mode-changed'));
    // onAuthStateChange will fire with null and update state. Also set here
    // to avoid a one-frame flash of stale user data.
    set({ session: null, user: null, sessionUnverified: false });
    // v1.18.1 (NCC#186) — and once more now that no user is on screen: a sync
    // that finished during the wait above may have re-armed task reminders
    // (useSyncStore only does so while its user is still the one signed in).
    await cancelAllReminders();
  },
}));

// v1.18.1 (NCC#186): a reminder is scheduled only while someone is there to
// get it: a user on screen, or guest mode. Checked by scheduleNotification
// right before the native call.
setReminderAudience(() => !!useSessionStore.getState().user || isGuestModeKnown());

// v1.18.1 (limecore#59 §2, NCC#140): queued edits are tagged with the user on
// screen (null as a guest), from the moment the session is known. See
// db/syncQueue.ts. The stored user counts while the server cannot be asked:
// that is the account the edits are made in.
let claimed = false;
useSessionStore.subscribe((s) => {
  if (!s.initialized) return;
  setQueueOwner(s.user?.id ?? null);
  if (!claimed) {
    claimed = true;
    claimUnowned(s.user?.id ?? null).catch((e) => console.warn('[sync] claimUnowned failed:', (e as Error).message));
  }
});
