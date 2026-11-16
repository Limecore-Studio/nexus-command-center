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
//   2. The JWT is verified by asking Auth to resolve it rather than by decoding
//      it here — a forged or expired token resolves to no user and is rejected.
//   3. Only `hashed_token` is returned, never the generated action link. The
//      link carries a redirect target and is the half of this that would be
//      useful in a phishing email; the bare hash is not.
//   4. This grants the caller nothing it did not already have. A caller who
//      reaches step 3 has already demonstrated a live session for that user.
//      The exchange converts one valid credential into another for the same
//      user — it is not a privilege boundary being crossed.
//   5. Abuse bounds (policy.ts): at most MINT_CAP mints per user per window
//      (429 above it), and CORS only for the sibling apps' WebView origin.
//
// Deploy:  supabase functions deploy suite-session
// Secrets: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected by the
//          platform; nothing needs to be set by hand.

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { capBucket, capDecision, corsHeaders, MINT_CAP, MINT_WINDOW } from './policy.ts';

// Logged only, never trusted for anything. Anything outside the list is
// recorded as 'unknown' rather than rejected: this string has no authority, so
// validating it would imply it did.
const KNOWN_APPS = ['limelog', 'studydesk', 'nexus'];

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

  // Resolve the caller from their token. This is the only source of identity.
  const { data: userData, error: userErr } = await admin.auth.getUser(token);
  const user = userData?.user;
  if (userErr || !user?.email) {
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
