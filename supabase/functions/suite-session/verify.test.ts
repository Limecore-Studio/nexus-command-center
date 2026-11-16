// Run: deno test supabase/functions/suite-session/verify.test.ts
// v1.21.1 (limecore#101) — the token rules suite-session applies itself.
import { assertEquals } from 'jsr:@std/assert@1';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jsr:@panva/jose@6';
import { MAX_EXPIRED_SECONDS, verifyCallerToken } from './verify.ts';

const ISS = 'https://example.supabase.co/auth/v1';
const SUB = '11111111-2222-4333-8444-555555555555';
const SID = '66666666-7777-4888-9999-000000000000';
const NOW = new Date('2026-11-16T12:00:00Z');
const nowS = NOW.getTime() / 1000;
const HOUR = 3600;

const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'ES256' };
const jwks = createLocalJWKSet({ keys: [jwk] });
const other = await generateKeyPair('ES256');

function token(claims: Record<string, unknown> = {}, opts: { key?: CryptoKey; kid?: string } = {}) {
  const exp = (claims.exp as number | undefined) ?? nowS + HOUR;
  return new SignJWT({
    role: 'authenticated',
    session_id: SID,
    is_anonymous: false,
    email: 'a@example.com',
    ...claims,
  })
    .setProtectedHeader({ alg: 'ES256', kid: opts.kid ?? 'k1' })
    .setIssuer((claims.iss as string) ?? ISS)
    .setAudience((claims.aud as string) ?? 'authenticated')
    .setSubject((claims.sub as string) ?? SUB)
    .setIssuedAt(exp - HOUR)
    .setExpirationTime(exp)
    .sign(opts.key ?? privateKey);
}
const check = (t: string) => verifyCallerToken(t, { jwks, issuer: ISS, now: NOW });

Deno.test('a current token passes, with its user and session', async () => {
  assertEquals(await check(await token()), { ok: true, userId: SUB, sessionId: SID });
});

Deno.test('expired 1 hour ago still passes (the case this exists for)', async () => {
  assertEquals((await check(await token({ exp: nowS - HOUR }))).ok, true);
});

Deno.test('expired just inside 7 days passes; 8 days does not', async () => {
  assertEquals((await check(await token({ exp: nowS - MAX_EXPIRED_SECONDS + 60 }))).ok, true);
  assertEquals((await check(await token({ exp: nowS - 8 * 24 * HOUR }))).ok, false);
});

Deno.test('wrong signer, unknown kid or a tampered payload fails', async () => {
  assertEquals((await check(await token({}, { key: other.privateKey }))).ok, false);
  assertEquals((await check(await token({}, { kid: 'nope' }))).ok, false);
  const [h, p, s] = (await token()).split('.');
  const forged = btoa(JSON.stringify({ ...JSON.parse(atob(p.replace(/-/g, '+').replace(/_/g, '/'))), sub: '99999999-2222-4333-8444-555555555555' }))
    .replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  assertEquals((await check(`${h}.${forged}.${s}`)).ok, false);
});

Deno.test('an HS256 token is never accepted on this path', async () => {
  const secret = new TextEncoder().encode('x'.repeat(32));
  const hs = await new SignJWT({ role: 'authenticated', session_id: SID })
    .setProtectedHeader({ alg: 'HS256' }).setIssuer(ISS).setAudience('authenticated').setSubject(SUB)
    .setExpirationTime(nowS + HOUR).sign(secret);
  assertEquals((await check(hs)).ok, false);
});

Deno.test('issuer, audience, role, anonymous and missing ids are all checked', async () => {
  assertEquals((await check(await token({ iss: 'https://evil.example/auth/v1' }))).ok, false);
  assertEquals((await check(await token({ aud: 'anon' }))).ok, false);
  assertEquals((await check(await token({ role: 'service_role' }))).ok, false);
  assertEquals((await check(await token({ is_anonymous: true }))).ok, false);
  assertEquals((await check(await token({ session_id: undefined }))).ok, false);
  assertEquals((await check(await token({ sub: 'not-a-uuid' }))).ok, false);
});

Deno.test('garbage is rejected, not thrown', async () => {
  assertEquals((await check('not.a.jwt')).ok, false);
  assertEquals((await check('')).ok, false);
});
