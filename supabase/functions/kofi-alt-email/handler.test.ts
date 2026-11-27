// node --test supabase/functions/kofi-alt-email/handler.test.ts   (Node >= 23.6)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle, randomCode, type Deps, type RpcName } from './handler.ts';

const USER = '00000000-0000-0000-0000-0000000000a1';

function fake(over: Partial<Deps> & { status?: string } = {}) {
  const calls: { fn: RpcName; args: Record<string, unknown> }[] = [];
  const sent: { to: string; code: string }[] = [];
  const deps: Deps = {
    configured: true,
    getUser: async (t) => (t === 'good' ? { id: USER } : t === 'anon' ? { id: USER, is_anonymous: true } : null),
    rpc: async (fn, args) => {
      calls.push({ fn, args });
      return { data: over.status ?? 'sent', error: null };
    },
    sendCode: async (to, code) => {
      sent.push({ to, code });
      return true;
    },
    randomCode: () => '424242',
    ...over,
  };
  return { deps, calls, sent };
}

function post(body: unknown, token: string | null = 'good'): Request {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  return new Request('https://x/functions/v1/kofi-alt-email', {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function read(res: Response) {
  return { code: res.status, text: await res.text() };
}

test('preflight answers with CORS headers', async () => {
  const res = await handle(new Request('https://x', { method: 'OPTIONS' }), fake().deps);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('Access-Control-Allow-Headers') ?? '', /authorization/);
});

test('only POST', async () => {
  assert.equal((await handle(new Request('https://x'), fake().deps)).status, 405);
});

test('fails closed when a secret is missing, before recording anything', async () => {
  const f = fake({ configured: false });
  assert.equal((await handle(post({ action: 'begin', email: 'a@b.co' }), f.deps)).status, 503);
  assert.equal(f.calls.length, 0);
  assert.equal(f.sent.length, 0);
});

test('no token, bad token, anonymous', async () => {
  assert.equal((await handle(post({ action: 'clear' }, null), fake().deps)).status, 401);
  assert.equal((await handle(post({ action: 'clear' }, 'bad'), fake().deps)).status, 401);
  assert.equal((await handle(post({ action: 'clear' }, 'anon'), fake().deps)).status, 403);
});

test('identity comes from the token, never the body', async () => {
  const f = fake({ status: 'cleared' });
  await handle(post({ action: 'clear', p_user: 'ffffffff-0000-0000-0000-00000000ffff', user_id: 'x' }), f.deps);
  assert.deepEqual(f.calls, [{ fn: 'kofi_alt_email_clear', args: { p_user: USER } }]);
});

test('malformed body or unknown action is a 400', async () => {
  assert.equal((await handle(post('{nope'), fake().deps)).status, 400);
  assert.equal((await handle(post('null'), fake().deps)).status, 400);
  assert.equal((await handle(post({ action: 'grant' }), fake().deps)).status, 400);
});

test('begin: an obvious typo never reaches the database', async () => {
  const f = fake();
  const r = await read(await handle(post({ action: 'begin', email: 'no-at-sign' }), f.deps));
  assert.deepEqual(r, { code: 200, text: '{"status":"invalid_email"}' });
  assert.equal(f.calls.length, 0);
});

test('begin: records, then mails the code to the normalised address', async () => {
  const f = fake();
  const r = await read(await handle(post({ action: 'begin', email: '  Me@Example.COM ' }), f.deps));
  assert.deepEqual(f.calls, [
    { fn: 'kofi_alt_email_begin', args: { p_user: USER, p_email: 'me@example.com', p_code: '424242' } },
  ]);
  assert.deepEqual(f.sent, [{ to: 'me@example.com', code: '424242' }]);
  assert.deepEqual(r, { code: 200, text: '{"status":"sent"}' });
});

test('begin: the code is never in the response', async () => {
  for (const status of ['sent', 'too_soon', 'already_verified']) {
    const r = await read(await handle(post({ action: 'begin', email: 'a@b.co' }), fake({ status }).deps));
    assert.ok(!r.text.includes('424242'), status);
  }
});

test('begin: a refusal sends nothing', async () => {
  for (const status of ['too_soon', 'rate_limited', 'busy', 'already_verified', 'no_user', 'invalid_email']) {
    const f = fake({ status });
    const r = await read(await handle(post({ action: 'begin', email: 'a@b.co' }), f.deps));
    assert.equal(f.sent.length, 0, status);
    assert.equal(r.text, JSON.stringify({ status }));
  }
});

test('begin: a mail failure is reported, not hidden', async () => {
  const f = fake({ sendCode: async () => false });
  const r = await read(await handle(post({ action: 'begin', email: 'a@b.co' }), f.deps));
  assert.equal(r.text, '{"status":"send_failed"}');
});

test('confirm: pasted spacing is forgiven', async () => {
  const f = fake({ status: 'verified' });
  const r = await read(await handle(post({ action: 'confirm', code: ' 424 242 ' }), f.deps));
  assert.deepEqual(f.calls, [{ fn: 'kofi_alt_email_confirm', args: { p_user: USER, p_code: '424242' } }]);
  assert.equal(r.text, '{"status":"verified"}');
});

test('confirm: a malformed code is wrong without spending a try', async () => {
  for (const code of ['12345', '1234567', 'abcdef', '', 42]) {
    const f = fake();
    const r = await read(await handle(post({ action: 'confirm', code }), f.deps));
    assert.equal(r.text, '{"status":"wrong"}');
    assert.equal(f.calls.length, 0, String(code));
  }
});

test('a database error is a 500 with nothing in it', async () => {
  const f = fake({ rpc: async () => ({ data: null, error: { message: 'boom: a@b.co' } }) });
  const r = await read(await handle(post({ action: 'begin', email: 'a@b.co' }), f.deps));
  assert.equal(r.code, 500);
  assert.ok(!r.text.includes('a@b.co') && !r.text.includes('424242'));
  assert.equal(f.sent.length, 0);
});

test('randomCode: six digits, and not stuck', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 2000; i++) {
    const c = randomCode();
    assert.match(c, /^\d{6}$/);
    seen.add(c);
  }
  assert.ok(seen.size > 1990);
});
