// Limecore suite — server-side Gemini proxy. v1.5 (SEC-1: durable rate limits).
//
// DEPLOYED to Supabase project hkktorzhaqnfqsnlstda as edge function
// `ai-generate` (verify_jwt = true). This file is the version-controlled copy;
// deploy via the Supabase MCP / `supabase functions deploy ai-generate`.
//
// On-device Gemini Nano is unavailable on the S24 (ML Kit GenAI features
// FEATURE_NOT_FOUND — see the AI-1 registry blocker), so the suite's AI
// features route through this function instead. The Gemini API key lives ONLY
// here as the GEMINI_API_KEY secret — never in the app bundle. Auth-gated:
// only signed-in suite users can call it. The prompt is NOT logged (privacy).
//
// Request  (POST JSON): { prompt: string, maxTokens?: number, temperature?: number, json?: boolean }
// Response (200 JSON):   { text: string }
// Errors:                { error: string, detail?/reason? } with an appropriate status.
//                        401 when the caller is not a signed-in user (v1.18.1).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const GEMINI_MODEL = Deno.env.get("GEMINI_MODEL") ?? "gemini-2.5-flash";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function clampNum(v: unknown, lo: number, hi: number, def: number): number {
  const n = typeof v === "number" && isFinite(v) ? v : def;
  return Math.min(hi, Math.max(lo, n));
}
function clampInt(v: unknown, lo: number, hi: number, def: number): number {
  const n = typeof v === "number" && isFinite(v) ? Math.round(v) : def;
  return Math.min(hi, Math.max(lo, n));
}

// ---------------------------------------------------------------------------
// Rate limiting.
//
// verify_jwt = true means the Supabase gateway has already checked the
// caller's signature before we run, but the gateway does not itself throttle
// call volume. Without a limit here, any authenticated user (or anyone
// holding a leaked JWT) could loop this function unboundedly, and every call
// hits the Gemini API on our server-side GEMINI_API_KEY — uncapped billing
// exposure. These two limits are a first layer against that: a per-user
// sliding window, plus a global cap shared across all callers.
//
// SEC-1 (2026-08-01): the in-memory Map below is no longer the authoritative
// limiter, because it could not be one. It only held for the lifetime of a
// single isolate, and Supabase spins up isolates on cold start, concurrent
// load and geographic routing — so the "global" cap was really per-isolate
// and never bounded total call volume. Worse, the per-user window keys on the
// JWT `sub`, and signup is open: rotating free accounts reset it at zero cost.
//
// The note that used to sit here justified all that with "personal suite, ~2
// real users." There are 193 accounts. Anyone who can `git clone` could
// exhaust the project's Gemini free-tier daily quota and hand every real user
// a 429 — a cheap denial-of-service on a shipped feature, and uncapped billing
// exposure the moment the tier stops being free.
//
// So the authoritative limiter is now `public.check_ai_rate_limit()`, backed
// by a Postgres counters table (migration 20260801_ai_rate_limits.sql) — the
// escalation path this comment used to merely name. It is process-wide and
// survives isolate churn, which is what makes the global caps real and what
// makes account rotation pointless.
//
// The in-memory limiter is KEPT as a free first layer: it costs one Map lookup,
// catches the common runaway-loop case with no network round-trip, and is the
// fallback if the database check fails (see checkLimits).
// ---------------------------------------------------------------------------

const USER_WINDOW_MS = 60_000; // 60s sliding window
const USER_LIMIT = 10; // ...max 10 requests per user in that window
const GLOBAL_WINDOW_MS = 60 * 60_000; // 1h sliding window
const GLOBAL_LIMIT = 120; // ...max 120 requests total, across all users
const GLOBAL_KEY = "__global__";

// Daily caps, enforced only by the durable limiter — an in-memory day window
// is meaningless when isolates are recycled far more often than daily.
//
// GLOBAL_DAY_LIMIT is the one that matters: it maps to the Gemini free tier's
// project-wide daily request cap, which is the actually-exhaustible resource.
// The default is deliberately conservative. CONFIRM THE CURRENT FREE-TIER RPD
// IN GOOGLE AI STUDIO before raising it — Google has changed that figure more
// than once, so it is env-tunable rather than baked in.
//
// v1.18.1 — the per-user default was 50 against a global 200: four accounts
// could switch AI off for everyone until the window reset. 20 keeps a real
// user's day (a few debriefs and narratives) and makes that take ten. Signup
// is open, so no per-user cap can stop rotation outright; it only raises the
// cost. If AI_USER_DAY_LIMIT is set as a secret, it overrides this default.
const USER_DAY_LIMIT = Number(Deno.env.get("AI_USER_DAY_LIMIT") ?? 20);
const GLOBAL_DAY_LIMIT = Number(Deno.env.get("AI_GLOBAL_DAY_LIMIT") ?? 200);
const DAY_WINDOW_MS = 24 * 60 * 60_000; // for Retry-After on a daily rejection

// key -> recent request timestamps (ms). Pruned lazily on each lookup.
const requestLog = new Map<string, number[]>();

// Prunes `key`'s bucket to only timestamps within `windowMs` of `now`. If the
// pruned count is already at `limit`, the request is rejected and NOT
// recorded (it didn't happen, as far as the window is concerned). Otherwise
// `now` is appended and the request is allowed.
function checkAndRecord(key: string, windowMs: number, limit: number, now: number): boolean {
  const recent = (requestLog.get(key) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= limit) {
    requestLog.set(key, recent);
    return false;
  }
  recent.push(now);
  requestLog.set(key, recent);
  return true;
}

// The gateway already verified this JWT's signature (verify_jwt = true), so
// it's safe to just decode the payload locally to bucket requests per-user —
// no need to pull in a JWT library or re-verify anything.
//
// v1.18.1 — only a signed-in user's token is accepted. verify_jwt passes ANY
// token the project signed, including the public anon key bundled in every
// app, so the old "anon" bucket handed AI to anyone holding that key, and a
// few such callers could use up the global daily cap for every real user.
// Returns null when the token is not a signed-in user's.
function getUserIdFromAuthHeader(req: Request): string | null {
  const auth = req.headers.get("Authorization") ?? req.headers.get("authorization") ?? "";
  const token = auth.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return null;
  try {
    const payloadSeg = token.split(".")[1];
    const b64 = payloadSeg.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const payload = JSON.parse(atob(padded));
    if (payload.role !== "authenticated" || payload.is_anonymous === true) return null;
    return typeof payload.sub === "string" && payload.sub ? payload.sub : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The durable half of the limiter.
//
// Calls public.check_ai_rate_limit() over PostgREST with the service-role key.
// Plain fetch rather than supabase-js: this is one RPC with a three-field body,
// and the client library would be the function's only runtime dependency.
//
// EXECUTE on that routine is revoked from anon and authenticated precisely so
// a caller cannot reach it directly and pre-burn someone else's bucket; the
// service-role key is what gets us in. Both env vars are injected by the
// platform, so there is no new secret to manage.
// ---------------------------------------------------------------------------

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

/**
 * One durable bucket check. Returns whether the call is allowed, or null if
 * the check could not be completed — null means "no answer", which the caller
 * treats differently from a definite false.
 */
async function checkDurable(
  bucket: string,
  limit: number,
  windowInterval: string,
): Promise<boolean | null> {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) return null;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/check_ai_rate_limit`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({
        p_bucket: bucket,
        p_limit: limit,
        p_window: windowInterval,
      }),
    });
    if (!res.ok) return null;
    return (await res.json()) === true;
  } catch {
    // Network/DB trouble. Deliberately not logged with the bucket name, which
    // contains a user id.
    return null;
  }
}

/**
 * Full limit check: in-memory first (free, no round-trip), then the durable
 * counters that actually bound the Gemini quota.
 *
 * Returns the window (ms) that rejected the call, for Retry-After, or null if
 * everything passed.
 *
 * DEGRADATION: a durable check returning null (database unreachable) falls
 * back to the in-memory verdict rather than failing the request. A transient
 * database blip should not make an opt-in feature look broken, and the
 * in-memory layer still bounds the runaway-loop case. The trade is that a
 * database outage temporarily restores the pre-SEC-1 posture — acceptable,
 * because it is bounded by the outage rather than open indefinitely.
 */
async function checkLimits(userId: string, now: number): Promise<number | null> {
  // Per-user, then global — checked in this order so a request already
  // rejected for the user never also consumes a slot in a global bucket.
  if (!checkAndRecord(`user:${userId}`, USER_WINDOW_MS, USER_LIMIT, now)) {
    return USER_WINDOW_MS;
  }
  if (!checkAndRecord(GLOBAL_KEY, GLOBAL_WINDOW_MS, GLOBAL_LIMIT, now)) {
    return GLOBAL_WINDOW_MS;
  }

  if ((await checkDurable(`user:${userId}`, USER_LIMIT, "1 minute")) === false) {
    return USER_WINDOW_MS;
  }
  if ((await checkDurable(`user:${userId}:day`, USER_DAY_LIMIT, "1 day")) === false) {
    return DAY_WINDOW_MS;
  }
  if ((await checkDurable("global:hour", GLOBAL_LIMIT, "1 hour")) === false) {
    return GLOBAL_WINDOW_MS;
  }
  if ((await checkDurable("global:day", GLOBAL_DAY_LIMIT, "1 day")) === false) {
    return DAY_WINDOW_MS;
  }
  return null;
}

// 429 with a Retry-After header — json() doesn't carry extra headers, so this
// builds the response inline for this one case rather than extending it.
function rateLimited(windowMs: number): Response {
  const retryAfter = Math.ceil(windowMs / 1000);
  return new Response(JSON.stringify({ error: "rate limited", retryAfter }), {
    status: 429,
    headers: { ...CORS, "Content-Type": "application/json", "Retry-After": String(retryAfter) },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const apiKey = Deno.env.get("GEMINI_API_KEY");
  if (!apiKey) return json({ error: "AI not configured (GEMINI_API_KEY secret not set)" }, 503);

  // Rate limit BEFORE any upstream call, so a rejected request never reaches
  // Gemini and never costs anything.
  const now = Date.now();
  const userId = getUserIdFromAuthHeader(req);
  if (!userId) return json({ error: "sign in required" }, 401);
  const rejectedWindowMs = await checkLimits(userId, now);
  if (rejectedWindowMs !== null) return rateLimited(rejectedWindowMs);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }

  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) return json({ error: "prompt is required" }, 400);
  if (prompt.length > 8000) return json({ error: "prompt too long (max 8000 chars)" }, 400);

  const temperature = clampNum(body.temperature, 0, 2, 0.6);
  const maxOutputTokens = clampInt(body.maxTokens, 1, 1024, 256);
  const wantJson = body.json === true;

  // 2026-10-26 (limecore#60): the 2.5 models no longer serve new projects, so
  // GEMINI_MODEL is now a 3.x model (gemini-3.5-flash-lite). Google's 3.x
  // guidance: `thinkingBudget` is legacy, replaced by `thinkingLevel` (sending
  // both is a 400), and temperature/top_p/top_k are deprecated and ignored,
  // with a 400 announced for later generations. So 3.x gets the lowest thinking
  // level and no temperature; a 2.x model keeps the old config unchanged.
  //
  // Thinking is billed against maxOutputTokens, so a small cap can be used up
  // by reasoning and return only a few visible words. These are short
  // narrative/extraction tasks: keep thinking at the minimum.
  const legacyModel = /^gemini-2\./.test(GEMINI_MODEL);
  const generationConfig: Record<string, unknown> = legacyModel
    ? { temperature, maxOutputTokens, thinkingConfig: { thinkingBudget: 0 } }
    : { maxOutputTokens, thinkingConfig: { thinkingLevel: "MINIMAL" } };
  if (wantJson) generationConfig.responseMimeType = "application/json";

  // v1.18.1 — the key goes in a header, never the URL. Fetch errors carry the
  // request URL, and the old catch below returned that message to the caller,
  // so any network failure toward Google could hand the key to whoever called.
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig,
      }),
    });
  } catch (e) {
    // The detail stays in the function logs; the caller gets a generic error.
    console.error("ai-generate: upstream fetch failed:", (e as Error).message);
    return json({ error: "upstream unavailable" }, 502);
  }

  if (!resp.ok) {
    // The body can carry project and quota details; it goes to the logs only.
    const detail = await resp.text();
    console.error(`ai-generate: Gemini ${resp.status}:`, detail.slice(0, 500));
    return json({ error: `Gemini ${resp.status}` }, resp.status === 429 ? 429 : 502);
  }

  const data = await resp.json();
  const parts = data?.candidates?.[0]?.content?.parts;
  const text = Array.isArray(parts)
    ? parts.map((p: { text?: string }) => p?.text ?? "").join("").trim()
    : "";
  if (!text) {
    const reason =
      data?.candidates?.[0]?.finishReason ?? data?.promptFeedback?.blockReason ?? "empty";
    return json({ error: "no text returned", reason }, 502);
  }

  return json({ text });
});
