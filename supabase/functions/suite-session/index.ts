// Suite SSO — mint an INDEPENDENT session for a sibling app.
//
// ── The bug this exists to kill ──────────────────────────────────────────
// NCC publishes its session bundle over a signed ContentProvider, and LimeLog
// and StudyDesk used to adopt it with `supabase.auth.setSession(...)`. That
// copies NCC's refresh_token, so all three apps end up holding the same token
// in the same rotation family. Supabase rotates a refresh_token on every use
// and treats a second presentation of an already-used token as theft: it
// revokes the ENTIRE family. Whichever app woke up second therefore signed all
// three out — the "logged out every day or two" report.
//
// The server-side evidence was unambiguous. On the owner's account, six
// sessions died in seventeen days, every one of them Android, every one with
// its whole token chain revoked and no successor issued, each death landing
// minutes after a *successful* rotation by a sibling — not after a long idle
// gap, which is what an expiry would look like. No desktop session ever died
// that way.
//
// ── The fix ─────────────────────────────────────────────────────────────
// Stop sharing the token. The sibling proves who it is with NCC's access_token
// and gets back a one-time credential it can exchange for a session of its
// own, with its own independent refresh-token family. After that the three
// apps refresh on separate rotation chains and cannot revoke each other.
//
// Safety properties, in order of how badly they would go wrong if missing:
//
//   1. The user is taken from the caller's own JWT and never from the request
//      body. There is no parameter naming a user or an email, so this endpoint
//      cannot be aimed at somebody else's account no matter what is posted.
//   2. The JWT is verified here (verify.ts): signature against the project's
//      JWKS, issuer, audience, and `exp` at most 7 days in the past; then its
//      `session_id` must still exist in auth.sessions for that user, and the
//      user must still exist. A forged token, a signed-out or revoked session
//      and a deleted user are all rejected. (v1.21.1, limecore#101: before,
//      Auth resolved the token and any expired one got a 401.)
//   3. Only `hashed_token` is returned, never the generated action link. The
//      link carries a redirect target and is the half of this that would be
//      useful in a phishing email; the bare hash is not.
//   4. This grants the caller nothing it did not already have. A caller who
//      reaches step 3 has already demonstrated a live session for that user:
//      a token that session issued, plus the session still existing. An NCC
//      sign-out does not end sessions already minted here (owner decision);
//      each is the sibling app's own, with its own sign-out.
//      The exchange converts one valid credential into another for the same
//      user — it is not a privilege boundary being crossed.
//   5. Abuse bounds (policy.ts): at most MINT_CAP mints per user per window
//      (429 above it), and CORS only for the sibling apps' WebView origin.
//
// Deploy:  supabase functions deploy suite-session --no-verify-jwt
//          (also set in supabase/config.toml). The platform check would
//          answer an expired token with its own 401, without CORS headers,
//          before this code runs. Every 401 here carries CORS headers.
//          Needs migration 20261116_v1211_suite_session_alive.sql first.
// Secrets: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected by the
//          platform. SUITE_SESSION_ISSUER is for the local stack only, where
//          tokens name the public URL but SUPABASE_URL is the internal one.

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { createRemoteJWKSet } from 'jsr:@panva/jose@6';
import { capBucket, capDecision, corsHeaders, MINT_CAP, MINT_WINDOW } from './policy.ts';
import { verifyCallerToken } from './verify.ts';

// Logged only, never trusted for anything. Anything outside the list is
// recorded as 'unknown' rather than rejected: this string has no authority, so
// validating it would imply it did.
const KNOWN_APPS = ['limelog', 'studydesk', 'nexus'];

// One key set per isolate, so the JWKS is cached between requests.
let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

Deno.serve(async (req: Request) => {
  const cors = corsHeaders(req.headers.get('Origin'));
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });

  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token) return json({ error: 'Missing authorization' }, 401);

  const url = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !serviceKey) return json({ error: 'Server misconfigured' }, 500);

  const admin = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // The caller's token is the only source of identity (verify.ts).
  jwks ??= createRemoteJWKSet(new URL(`${url}/auth/v1/.well-known/jwks.json`));
  const verdict = await verifyCallerToken(token, {
    jwks,
    issuer: Deno.env.get('SUITE_SESSION_ISSUER') ?? `${url}/auth/v1`,
  });
  if (!verdict.ok) {
    console.log('suite-session rejected', { reason: verdict.reason });
    return json({ error: 'Invalid or expired session' }, 401);
  }

  // The session must still exist: signed out or revoked ends it at once.
  // Fails closed: without the answer nothing is minted.
  const alive = await admin.rpc('suite_session_alive', {
    p_session_id: verdict.sessionId,
    p_user_id: verdict.userId,
  });
  if (alive.error) {
    console.error('suite-session session check failed', { userId: verdict.userId, message: alive.error.message });
    return json({ error: 'try again later' }, 503);
  }
  if (alive.data !== true) {
    console.log('suite-session rejected', { reason: 'session-ended', userId: verdict.userId });
    return json({ error: 'Invalid or expired session' }, 401);
  }

  // And the user must still exist, unbanned. The email comes from here, the
  // current record, never from the token or the request.
  const { data: userData, error: userErr } = await admin.auth.admin.getUserById(verdict.userId);
  const user = userData?.user;
  const banned = user?.banned_until ? Date.parse(user.banned_until) > Date.now() : false;
  if (userErr || !user?.email || banned) {
    return json({ error: 'Invalid or expired session' }, 401);
  }

  let app = 'unknown';
  try {
    const body = await req.json();
    if (typeof body?.app === 'string' && KNOWN_APPS.includes(body.app)) app = body.app;
  } catch {
    // A missing or unparseable body is fine — `app` is diagnostic only.
  }

  // Per-user cap, keyed on the JWT-resolved user (see policy.ts). Checked
  // before minting; a rejected call still counts, so hammering stays blocked.
  const cap = capDecision(
    await admin.rpc('check_ai_rate_limit', {
      p_bucket: capBucket(user.id),
      p_limit: MINT_CAP,
      p_window: MINT_WINDOW,
    }),
  );
  if (cap === 'deny') {
    console.warn('suite-session cap hit', { userId: user.id, app, at: new Date().toISOString() });
    return json({ error: 'try again later' }, 429);
  }
  if (cap === 'allow-unchecked') {
    console.error('suite-session cap check failed, allowing', { userId: user.id, app });
  }

  // generateLink does NOT send mail; it returns the credential for us to hand
  // back over this already-authenticated channel. The email is the verified
  // one off the JWT-resolved user, so it cannot be steered by the caller.
  const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
    type: 'magiclink',
    email: user.email,
  });

  const hashedToken = linkData?.properties?.hashed_token;
  if (linkErr || !hashedToken) {
    console.error('suite-session mint failed', {
      userId: user.id,
      app,
      message: linkErr?.message ?? 'no hashed_token in response',
    });
    return json({ error: 'Could not mint a session' }, 500);
  }

  // No email address in the log line — the user id is enough to trace this and
  // costs less if the logs are ever read by someone who should not have it.
  console.log('suite-session minted', { userId: user.id, app, at: new Date().toISOString() });

  return json({ token_hash: hashedToken, email: user.email });
});
