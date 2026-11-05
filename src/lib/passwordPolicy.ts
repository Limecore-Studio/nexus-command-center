// v1.20 (limecore#73) — the password rule, stated once.
//
// The SOURCE OF TRUTH is the Supabase project's Auth settings (Authentication >
// Policies: minimum length 10, "lowercase, uppercase letters, digits and
// symbols"). The server enforces it; this copy only explains it before the
// user hits it. Change the two together, and the same constant in StudyDesk
// and LimeLog, or the checklist will promise a password the server then refuses.
//
// The character sets are GoTrue's own, not "anything that isn't a letter":
// an `ä` or a space passes /[^A-Za-z0-9]/ but is not one of the server's
// symbols, so a looser test would tick the box and the sign-up would still fail.

export const PASSWORD_MIN_LENGTH = 10;

const SYMBOLS = '!@#$%^&*()_+-=[]{};\'\\:"|<>?,./`~';

/** The checklist items, in display order. */
export const PASSWORD_RULES: { id: string; test: (pw: string) => boolean }[] = [
  { id: 'length', test: (pw) => pw.length >= PASSWORD_MIN_LENGTH },
  { id: 'lower', test: (pw) => /[a-z]/.test(pw) },
  { id: 'upper', test: (pw) => /[A-Z]/.test(pw) },
  { id: 'digit', test: (pw) => /[0-9]/.test(pw) },
  { id: 'symbol', test: (pw) => [...pw].some((c) => SYMBOLS.includes(c)) },
];

export function checkPassword(pw: string | null | undefined): { id: string; ok: boolean }[] {
  const s = pw ?? '';
  return PASSWORD_RULES.map((r) => ({ id: r.id, ok: r.test(s) }));
}

export function meetsPasswordRule(pw: string): boolean {
  return checkPassword(pw).every((r) => r.ok);
}

/**
 * Why the server called a password weak: 'length' | 'characters' | 'pwned'.
 * supabase-js's AuthWeakPasswordError carries `reasons`; older payloads and
 * plain errors only have GoTrue's English message, so that is read as a
 * fallback. Empty when neither says.
 */
export function weakPasswordReasons(err: { reasons?: unknown; message?: string } | null | undefined): string[] {
  const known = ['length', 'characters', 'pwned'];
  if (Array.isArray(err?.reasons)) {
    const r = (err.reasons as unknown[]).filter((x): x is string => typeof x === 'string' && known.includes(x));
    if (r.length) return r;
  }
  const m = (err?.message ?? '').toLowerCase();
  const out: string[] = [];
  if (/at least \d+ characters/.test(m)) out.push('length');
  if (m.includes('one character of each')) out.push('characters');
  if (m.includes('known to be weak') || m.includes('pwned') || m.includes('breach')) out.push('pwned');
  return out;
}
