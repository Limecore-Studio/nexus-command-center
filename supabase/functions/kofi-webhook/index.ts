// Ko-fi → supporter entitlement.
//
// ── Threat model, stated first because it drives every decision below ────────
//
// This endpoint is PUBLIC and UNAUTHENTICATED. It has to be: Ko-fi's servers
// post to it and cannot carry a Supabase JWT. The only thing standing between a
// stranger with curl and a forged entitlement is the verification token, so the
// rule this file is built around is:
//
//     NOTHING IN THE PAYLOAD IS READ UNTIL THE TOKEN HAS BEEN VERIFIED.
//
// Not the type, not the email, not the tier. This is `PAY-01` from the
// Never-Get-Hacked audit, which ranks unverified webhooks among its top
// killers, and that audit is scheduled to run against this function
// specifically before it goes live rather than after.
//
// The comparison is constant-time. `===` on a secret leaks its prefix through
// timing, which is `PAY-02` in the same list — and that audit already flags
// three `===` comparisons elsewhere in NCC that are NOT signatures. This one
// would have been a real instance of the thing those false positives are
// named after.
//
// ── What it is NOT defending ─────────────────────────────────────────────────
//
// The perk itself is cosmetic (themes, a badge) and the apps are open source
// and built from source by F-Droid. Anyone can delete the client-side check and
// build. That is fine and expected — see the migration's header. This function
// defends the DATABASE, so that a row asserting "this person paid" cannot be
// forged, self-granted, or stolen. It does not attempt to defend the pixels.
//
// ── Deploy ───────────────────────────────────────────────────────────────────
//
//   supabase functions deploy kofi-webhook --no-verify-jwt
//
// `--no-verify-jwt` is REQUIRED and is not a weakening: Ko-fi cannot present a
// Supabase JWT, so with the default gateway check every delivery would be
// rejected at the edge before this code ran. Authentication here is the
// verification token, checked below.
//
// Secrets (Supabase → Edge Functions → Secrets):
//   KOFI_VERIFICATION_TOKEN   from Ko-fi → More → API/Webhooks
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected by the platform.

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { storeUnmatched } from './unmatched.ts';

// A membership bills monthly; the grace absorbs a late or retried charge so a
// paying supporter never blinks out between a renewal falling due and it
// landing. NOTE: this assumes monthly billing. Ko-fi's payload does not state
// the interval, so an annual tier would need this widened — revisit if one is
// ever added.
const ENTITLEMENT_DAYS = 34;

function sha256(s: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
}

/** Constant-time equality. Compares digests, so the two inputs are always the
 *  same length and no early exit can leak where they first differ. */
async function tokensMatch(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([sha256(a), sha256(b)]);
  const ax = new Uint8Array(x);
  const ay = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < ax.length; i++) diff |= ax[i] ^ ay[i];
  return diff === 0;
}

/** Addresses are PII and this lands in a log the owner reads. Enough to find
 *  the person in Ko-fi's dashboard alongside the message id, not enough to turn
 *  the function log into a mailing list. */
function redact(email: string): string {
  const at = email.indexOf('@');
  if (at < 1) return '<malformed>';
  return email[0] + '***' + email.slice(at);
}

Deno.serve(async (req: Request) => {
  // Ko-fi only ever POSTs. Anything else is someone poking at the URL.
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const expected = Deno.env.get('KOFI_VERIFICATION_TOKEN');
  if (!expected) {
    // Fail CLOSED. A missing secret must never mean "accept everything".
    console.error('[kofi] KOFI_VERIFICATION_TOKEN is not set — rejecting.');
    return new Response('Not configured', { status: 503 });
  }

  // Ko-fi posts application/x-www-form-urlencoded with one field, `data`,
  // holding the JSON. Malformed input is a 400 and nothing is read from it.
  let payload: Record<string, unknown>;
  try {
    const form = await req.formData();
    const raw = form.get('data');
    if (typeof raw !== 'string') return new Response('Bad Request', { status: 400 });
    payload = JSON.parse(raw);
  } catch {
    return new Response('Bad Request', { status: 400 });
  }

  // ── THE GATE. Nothing below this point existed, as far as we are concerned,
  //    until the token checked out. ──────────────────────────────────────────
  const presented =
    typeof payload.verification_token === 'string' ? payload.verification_token : '';
  if (!(await tokensMatch(presented, expected))) {
    console.warn('[kofi] rejected delivery: verification token mismatch');
    return new Response('Unauthorized', { status: 401 });
  }

  const messageId = typeof payload.message_id === 'string' ? payload.message_id : null;
  const type = typeof payload.type === 'string' ? payload.type : '';
  const isSubscription = payload.is_subscription_payment === true;
  const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
  const tier =
    typeof payload.tier_name === 'string' && payload.tier_name.trim()
      ? payload.tier_name.trim()
      : 'Supporter';

  // One-off donations and shop orders are real and welcome, but they are not
  // memberships and carry no renewal, so they grant no timed entitlement. 200
  // so Ko-fi marks the delivery handled and stops retrying.
  if (type !== 'Subscription' && !isSubscription) {
    console.log('[kofi] ' + messageId + ': type=' + type + ' is not a membership payment — acknowledged, no entitlement');
    return new Response('OK', { status: 200 });
  }

  if (!email) {
    console.error('[kofi] ' + messageId + ': membership payment carried no email — cannot match');
    return new Response('OK', { status: 200 });
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  // The matching rules — including the two attacks they stop — live in
  // public.kofi_match_user. Read that before changing anything here.
  const { data: matched, error: matchError } = await supabase.rpc('kofi_match_user', {
    p_email: email,
  });

  if (matchError) {
    // A 500 asks Ko-fi to retry, which is what we want for a transient fault:
    // the payment is real and we would rather deliver it late than drop it.
    console.error('[kofi] ' + messageId + ': match failed: ' + matchError.message);
    return new Response('Internal Error', { status: 500 });
  }

  if (!matched) {
    // Not an error. The common case is a supporter who checked out with a
    // different address and has not verified it yet. 200 so Ko-fi does not
    // retry forever against a state that will not change on its own.
    //
    // v1.22 (limecore#112): the payment is KEPT (unmatched.ts), so verifying
    // that address later grants it (kofi_claim_unmatched). It used to live
    // only in this log line, and the in-app promise that "a payment may already
    // be waiting on this address" could not be kept.
    if (!messageId) {
      console.warn('[kofi] membership payment with no message id: no account matches ' + redact(email) + ', not stored');
      return new Response('OK', { status: 200 });
    }
    const outcome = await storeUnmatched(supabase, { messageId, email, tier });
    if (outcome === 'failed') {
      // The payment is real: ask Ko-fi to retry rather than lose it.
      console.error('[kofi] ' + messageId + ': no account matches; storing it failed, asking Ko-fi to retry');
      return new Response('Internal Error', { status: 500 });
    }
    console.warn(
      '[kofi] ' + messageId + ': no account matches ' + redact(email) +
        (outcome === 'stored' ? ', kept for a later claim' : ', not stored (kofi_unmatched_payments missing)'),
    );
    return new Response('OK', { status: 200 });
  }

  const expiresAt = new Date(Date.now() + ENTITLEMENT_DAYS * 86_400_000).toISOString();

  // Upsert on the primary key: a renewal moves the date forward, a replayed
  // delivery writes the same row again harmlessly. `first_supported_at` is left
  // to its default on insert and deliberately not touched on update, so it goes
  // on meaning "when they first supported".
  const { error: writeError } = await supabase.from('supporter_entitlements').upsert(
    {
      user_id: matched,
      tier,
      expires_at: expiresAt,
      source_email: email,
      kofi_message_id: messageId,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id' },
  );

  if (writeError) {
    console.error('[kofi] ' + messageId + ': entitlement write failed: ' + writeError.message);
    return new Response('Internal Error', { status: 500 });
  }

  console.log('[kofi] ' + messageId + ': entitlement granted, tier=' + tier + ', expires=' + expiresAt);
  return new Response('OK', { status: 200 });
});
