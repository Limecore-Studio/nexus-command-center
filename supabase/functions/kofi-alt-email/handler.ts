// kofi-alt-email: prove you own a Ko-fi checkout address (limecore#55).
//
// A supporter who paid Ko-fi from an address that isn't their login email
// links it here. The address only starts matching payments once its holder
// types back a code we emailed to it. The rules (one-time code, five tries,
// fifteen minutes, send limits, one account per verified address) live in the
// kofi_alt_email_* SQL functions, where they cannot be raced; this file only
// resolves who is asking, makes the code and sends the mail.
//
// Kept free of Deno and jsr imports so the logic can be tested under Node:
//   node --test supabase/functions/kofi-alt-email/handler.test.ts
// index.ts wires it to Deno.serve, the service-role client and Resend.
//
// Request:  POST { action: 'begin', email } | { action: 'confirm', code } | { action: 'clear' }
// Response: 200 { status } for every outcome the user should see (the SQL
//           function's answer, or 'send_failed'), so supabase-js invoke() hands
//           the client a readable body instead of a FunctionsHttpError.
//           4xx/5xx only for a broken request, session or server.

export const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

export type RpcName = 'kofi_alt_email_begin' | 'kofi_alt_email_confirm' | 'kofi_alt_email_clear';

export interface Caller {
  id: string;
  is_anonymous?: boolean;
}

export interface Deps {
  /** False when a secret is missing. Checked before anything is recorded, so
   *  a misconfigured deploy never spends a user's send allowance. */
  configured: boolean;
  getUser(token: string): Promise<Caller | null>;
  rpc(fn: RpcName, args: Record<string, unknown>): Promise<{ data: unknown; error: { message: string } | null }>;
  sendCode(to: string, code: string): Promise<boolean>;
  randomCode(): string;
}

// Same shape the SQL check enforces; the SQL is the authority, this only
// saves a round trip on an obvious typo.
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Six digits, uniform. Rejection sampling, because 2^32 is not a multiple of
 *  10^6 and a plain modulo would favour the low codes. */
export function randomCode(): string {
  const limit = 4_294_000_000; // the largest multiple of 1e6 below 2^32
  const buf = new Uint32Array(1);
  do {
    crypto.getRandomValues(buf);
  } while (buf[0] >= limit);
  return String(buf[0] % 1_000_000).padStart(6, '0');
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

export async function handle(req: Request, deps: Deps): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  // Fail closed: without the mail key a 'sent' would be a lie and would burn
  // one of the user's five daily sends on nothing.
  if (!deps.configured) return json({ error: 'Not configured' }, 503);

  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token) return json({ error: 'Missing authorization' }, 401);

  // The caller's identity comes from their token and nowhere else. A user id
  // in the body would let anyone act on anyone's row.
  const caller = await deps.getUser(token);
  if (!caller) return json({ error: 'Invalid or expired session' }, 401);
  if (caller.is_anonymous) return json({ error: 'Sign in with an account first' }, 403);

  let body: Record<string, unknown>;
  try {
    const parsed = await req.json();
    if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
    body = parsed as Record<string, unknown>;
  } catch {
    return json({ error: 'Bad request' }, 400);
  }

  const call = async (fn: RpcName, args: Record<string, unknown>): Promise<string | null> => {
    const { data, error } = await deps.rpc(fn, { p_user: caller.id, ...args });
    if (error || typeof data !== 'string') {
      console.error('[kofi-alt-email] ' + fn + ' failed for ' + caller.id + ': ' + (error?.message ?? 'no status'));
      return null;
    }
    return data;
  };

  switch (body.action) {
    case 'begin': {
      const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
      if (email.length > 254 || !EMAIL_RE.test(email)) return json({ status: 'invalid_email' });

      const code = deps.randomCode();
      const status = await call('kofi_alt_email_begin', { p_email: email, p_code: code });
      if (status === null) return json({ error: 'Internal error' }, 500);
      if (status !== 'sent') {
        console.log('[kofi-alt-email] begin ' + caller.id + ': ' + status);
        return json({ status });
      }

      // The code goes to the address and nowhere else: never in the response,
      // never in a log line.
      const delivered = await deps.sendCode(email, code);
      console.log('[kofi-alt-email] begin ' + caller.id + ': ' + (delivered ? 'sent' : 'send_failed'));
      return json({ status: delivered ? 'sent' : 'send_failed' });
    }

    case 'confirm': {
      // People paste "123 456" or "123-456" from the mail.
      const code = typeof body.code === 'string' ? body.code.replace(/[\s-]/g, '') : '';
      // A malformed code cannot be right; answer without spending a try.
      if (!/^\d{6}$/.test(code)) return json({ status: 'wrong' });
      const status = await call('kofi_alt_email_confirm', { p_code: code });
      if (status === null) return json({ error: 'Internal error' }, 500);
      console.log('[kofi-alt-email] confirm ' + caller.id + ': ' + status);
      return json({ status });
    }

    case 'clear': {
      const status = await call('kofi_alt_email_clear', {});
      if (status === null) return json({ error: 'Internal error' }, 500);
      console.log('[kofi-alt-email] clear ' + caller.id + ': ' + status);
      return json({ status });
    }

    default:
      return json({ error: 'Bad request' }, 400);
  }
}
