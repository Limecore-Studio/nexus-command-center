// Request policy for `suite-session`: which browser origins may call it, and
// how a per-user cap check result is turned into a decision. These are pure
// functions so they can be unit-tested without a network or a database.

// ── CORS ─────────────────────────────────────────────────────────────────
// Only the sibling Android apps call this endpoint (StudyDesk and LimeLog,
// both behind `Capacitor.isNativePlatform()`), and neither sets
// `androidScheme` / `hostname` or enables CapacitorHttp, so their WebView
// sends `Origin: https://localhost`. Web and desktop builds never call it.
//
// An unknown origin gets no CORS headers at all, so a website cannot drive
// this endpoint from a visitor's browser. CORS is not an auth control: a
// script with a stolen token ignores it. The per-user cap is the real limit.
// If a new caller is added (a desktop SSO, say), add its exact origin here.
export const ALLOWED_ORIGINS: ReadonlySet<string> = new Set(['https://localhost']);

const CORS_BASE = {
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

export function corsHeaders(origin: string | null): Record<string, string> {
  // `Vary: Origin` either way: a cache must not serve one origin's answer to another.
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    return { ...CORS_BASE, 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
  }
  return { Vary: 'Origin' };
}

// ── Per-user cap ─────────────────────────────────────────────────────────
// The sibling apps mint once per sign-in, so normal use is a handful a day at
// most. Counted in the durable `check_ai_rate_limit()` counter (service-role
// only), under its own bucket prefix, because Edge isolates share no memory.
// The window is fixed, not rolling: up to 2x the cap across one boundary,
// which is fine for an abuse bound.
export const MINT_CAP = 10;
export const MINT_WINDOW = '24 hours';

export function capBucket(userId: string): string {
  return `suite-session:user:${userId}`;
}

export type CapDecision = 'allow' | 'deny' | 'allow-unchecked';

// Fail open when the counter itself errors. The caller has already proven a
// live session for this user, and when this endpoint fails the sibling apps
// fall back to sharing NCC's refresh token, which is the sign-out bug this
// function exists to prevent. A short counter outage must not bring that
// back for everyone. `allow-unchecked` is logged so an outage shows up.
export function capDecision(result: { data: unknown; error: unknown }): CapDecision {
  if (result.error) return 'allow-unchecked';
  if (result.data === false) return 'deny';
  if (result.data === true) return 'allow';
  return 'allow-unchecked';
}
