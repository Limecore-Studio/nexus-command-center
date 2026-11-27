// kofi-alt-email: Deno wiring for handler.ts (read that first, limecore#55).
//
// Deploy (JWT verification ON, the default; this is a signed-in-user endpoint):
//   supabase functions deploy kofi-alt-email
//
// Secrets (Supabase → Edge Functions → Secrets):
//   RESEND_API_KEY   a Resend key with sending access to limecore.dev only.
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected by the platform.
// Without RESEND_API_KEY every request is a 503 before anything is recorded.

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { handle, randomCode } from './handler.ts';
import { codeEmail } from './email.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') ?? '';

// The sender the auth mails already use, so SPF/DKIM are the verified ones.
const FROM = 'Limecore <auth@limecore.dev>';

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function sendCode(to: string, code: string): Promise<boolean> {
  const { subject, html, text } = codeEmail(code);
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM, to: [to], subject, html, text }),
    });
    if (!res.ok) {
      // Resend's error body names the problem (domain, key scope) without
      // echoing the recipient.
      console.error('[kofi-alt-email] Resend ' + res.status + ': ' + (await res.text()).slice(0, 300));
    }
    return res.ok;
  } catch (e) {
    console.error('[kofi-alt-email] Resend unreachable: ' + (e instanceof Error ? e.message : String(e)));
    return false;
  }
}

Deno.serve((req: Request) =>
  handle(req, {
    configured: Boolean(SUPABASE_URL && SERVICE_ROLE_KEY && RESEND_API_KEY),
    getUser: async (token) => {
      const { data, error } = await admin.auth.getUser(token);
      return error || !data?.user ? null : { id: data.user.id, is_anonymous: data.user.is_anonymous };
    },
    rpc: async (fn, args) => {
      const { data, error } = await admin.rpc(fn, args);
      return { data, error: error ? { message: error.message } : null };
    },
    sendCode,
    randomCode,
  }),
);
