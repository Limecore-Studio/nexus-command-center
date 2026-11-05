// v1.8 / ACT-2 — translated copy for Supabase auth failures.
//
// `error.message` off signInWithPassword / signUp / exchangeCodeForSession is
// server-supplied and always English, so translating the gate's own literals
// isn't enough: the one string a user sees *after* something goes wrong would
// still come back in English.
//
// We map the handful of codes that actually show up on the gate and fall
// through to the raw message for everything else. Swallowing the unmapped tail
// behind a generic "something went wrong" would cost more than the English
// costs — an untranslated but accurate message still tells the user (or Emil,
// reading a bug report) what happened.
//
// supabase-js ≥2.100 sets a stable `code` on AuthError; the message-substring
// arm is a fallback for older payloads and for errors raised as plain Error
// (e.g. the network failures fetch throws before Supabase sees them).

import type { TFunction } from 'i18next';
import { PASSWORD_MIN_LENGTH, weakPasswordReasons } from './passwordPolicy';

// v1.20 (limecore#73) — say WHAT is wrong with a refused password; the one
// generic line this replaced sent a visitor round five times in 40 s. The
// auth.pw* strings load with the sign-up screen (i18n/passwordStrings.ts), the
// only screen that sets a password; this module is also on the startup path
// (Login), so it does not import them itself.
const REASON_KEYS: Record<string, string> = {
  length: 'auth.pwReasonLength',
  characters: 'auth.pwReasonCharacters',
  pwned: 'auth.pwReasonPwned',
};

function weakPasswordMessage(err: { reasons?: unknown; message?: string }, t: TFunction): string {
  let reasons = weakPasswordReasons(err);
  // No reason given: state the whole rule rather than "choose a stronger one".
  if (!reasons.length) reasons = ['length', 'characters'];
  return reasons.map((r) => t(REASON_KEYS[r], { n: PASSWORD_MIN_LENGTH })).join(' ');
}

/** Supabase auth error codes → `auth.*` i18n keys. */
const CODE_KEYS: Record<string, string> = {
  invalid_credentials: 'auth.errInvalidCredentials',
  invalid_grant: 'auth.errInvalidCredentials',
  user_already_exists: 'auth.errAlreadyRegistered',
  email_exists: 'auth.errAlreadyRegistered',
  weak_password: 'auth.errWeakPassword',
  email_not_confirmed: 'auth.errEmailNotConfirmed',
  over_request_rate_limit: 'auth.errRateLimited',
  over_email_send_rate_limit: 'auth.errRateLimited',
};

/** Lower-cased message fragments → `auth.*` i18n keys, for code-less errors. */
const MESSAGE_KEYS: [string, string][] = [
  ['invalid login credentials', 'auth.errInvalidCredentials'],
  ['already registered', 'auth.errAlreadyRegistered'],
  ['already been registered', 'auth.errAlreadyRegistered'],
  ['user already exists', 'auth.errAlreadyRegistered'],
  ['email not confirmed', 'auth.errEmailNotConfirmed'],
  ['rate limit', 'auth.errRateLimited'],
  ['too many requests', 'auth.errRateLimited'],
  ['failed to fetch', 'auth.errNetwork'],
  ['network request failed', 'auth.errNetwork'],
  ['networkerror', 'auth.errNetwork'],
];

type MaybeAuthError = { code?: string; message?: string; reasons?: unknown } | null | undefined;

/**
 * Translate a Supabase auth error, falling back to its raw (English) message.
 * Returns null only when there is genuinely nothing to show.
 */
export function translateAuthError(err: MaybeAuthError, t: TFunction): string | null {
  if (!err) return null;

  // The message arm only for code-less errors: GoTrue's same_password text
  // ("New password should be different…") also contains "password should".
  const weakMsg = (err.message ?? '').toLowerCase();
  if (err.code === 'weak_password'
    || (!err.code && (weakMsg.includes('password should') || weakMsg.includes('weak password')))) {
    return weakPasswordMessage(err, t);
  }

  const key = err.code ? CODE_KEYS[err.code] : undefined;
  if (key) return t(key);

  const message = err.message ?? '';
  const haystack = message.toLowerCase();
  const matched = MESSAGE_KEYS.find(([fragment]) => haystack.includes(fragment));
  if (matched) return t(matched[1]);

  // Unmapped — surface the server's own wording rather than hiding it.
  return message || null;
}
