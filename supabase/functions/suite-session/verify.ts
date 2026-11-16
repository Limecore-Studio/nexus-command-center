// v1.21.1 (limecore#101) — how `suite-session` checks the caller's token.
//
// The function runs with verify_jwt = false (see supabase/config.toml) and
// verifies the token itself, because it must accept one thing the platform
// check never will: an access token that expired recently, from a session
// that is still alive. NCC republishes its token only while it runs, so a
// sibling app usually holds one that expired within the last hour or days.
// Answering 401 to that is what sent older sibling builds to their fallback
// of sharing NCC's refresh token, which revokes NCC's whole session family.
//
// What is checked here, all of it, before anything is minted:
//   - the signature, against the project's published JWKS (ES256 today);
//     only asymmetric algorithms are accepted, so a token signed with a
//     shared secret can never pass this path;
//   - issuer and audience ('authenticated');
//   - `exp` at most MAX_EXPIRED_SECONDS in the past (owner decision: 7 days);
//   - role 'authenticated', a UUID `sub` and `session_id`, not anonymous.
// index.ts then checks that `session_id` still exists in auth.sessions for
// that user (a sign-out or a revoked session ends it at once) and that the
// user still exists.
//
// Key rotation: jose's remote key set caches the JWKS and refetches when a
// token names a `kid` it does not have (at most every 30 s). Supabase
// publishes a standby key in the JWKS before it starts signing with it, and
// a revoked key leaves the JWKS, so rotation and revocation need no deploy.
// Supabase's own edge cache adds up to about 20 minutes to a revocation.
import { jwtVerify, type JWTVerifyGetKey } from 'jsr:@panva/jose@6';

export const MAX_EXPIRED_SECONDS = 7 * 24 * 60 * 60;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type Verdict =
  | { ok: true; userId: string; sessionId: string }
  | { ok: false; reason: string };

export async function verifyCallerToken(
  token: string,
  opts: { jwks: JWTVerifyGetKey; issuer: string; now?: Date },
): Promise<Verdict> {
  const now = opts.now ?? new Date();
  let payload: Record<string, unknown>;
  try {
    ({ payload } = await jwtVerify(token, opts.jwks, {
      issuer: opts.issuer,
      audience: 'authenticated',
      algorithms: ['ES256', 'RS256'],
      // jose rejects an expired token; the tolerance lets one through for up
      // to the cap, and the explicit check below enforces the cap itself.
      clockTolerance: MAX_EXPIRED_SECONDS,
      currentDate: now,
    }));
  } catch (e) {
    return { ok: false, reason: (e as { code?: string }).code ?? 'invalid' };
  }
  const exp = payload.exp;
  if (typeof exp !== 'number') return { ok: false, reason: 'no-exp' };
  if (now.getTime() / 1000 - exp > MAX_EXPIRED_SECONDS) return { ok: false, reason: 'too-old' };
  if (payload.role !== 'authenticated') return { ok: false, reason: 'role' };
  if (payload.is_anonymous === true) return { ok: false, reason: 'anonymous' };
  const sub = payload.sub;
  const sid = payload.session_id;
  if (typeof sub !== 'string' || !UUID.test(sub)) return { ok: false, reason: 'sub' };
  if (typeof sid !== 'string' || !UUID.test(sid)) return { ok: false, reason: 'session' };
  return { ok: true, userId: sub, sessionId: sid };
}
