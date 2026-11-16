// Run: deno test supabase/functions/suite-session/policy.test.ts
import { assertEquals } from 'jsr:@std/assert@1';
import { capBucket, capDecision, corsHeaders, MINT_CAP } from './policy.ts';

Deno.test('cap: within the limit is allowed, over it is denied', () => {
  assertEquals(capDecision({ data: true, error: null }), 'allow');
  assertEquals(capDecision({ data: false, error: null }), 'deny');
});

Deno.test('cap: a failed or malformed counter fails open, flagged', () => {
  assertEquals(capDecision({ data: null, error: { message: 'boom' } }), 'allow-unchecked');
  assertEquals(capDecision({ data: false, error: { message: 'boom' } }), 'allow-unchecked');
  assertEquals(capDecision({ data: null, error: null }), 'allow-unchecked');
});

Deno.test('cap: bucket is per user and cannot collide with ai-generate buckets', () => {
  const id = '00000000-0000-0000-0000-000000000001';
  assertEquals(capBucket(id), `suite-session:user:${id}`);
  // ai-generate uses 'user:<uuid>', 'user:<uuid>:day', 'global:hour', 'global:day'.
  for (const other of [`user:${id}`, `user:${id}:day`, 'global:hour', 'global:day']) {
    if (capBucket(id) === other) throw new Error(`collides with ${other}`);
  }
  assertEquals(MINT_CAP, 10);
});

Deno.test('cors: the sibling WebView origin is echoed back', () => {
  const h = corsHeaders('https://localhost');
  assertEquals(h['Access-Control-Allow-Origin'], 'https://localhost');
  assertEquals(h['Vary'], 'Origin');
});

Deno.test('cors: unknown, lookalike and missing origins get no allow headers', () => {
  for (const o of ['https://evil.example', 'http://localhost', 'https://localhost.evil.example', 'null', null]) {
    const h = corsHeaders(o);
    assertEquals(h['Access-Control-Allow-Origin'], undefined, String(o));
    assertEquals(h['Access-Control-Allow-Headers'], undefined, String(o));
  }
});
