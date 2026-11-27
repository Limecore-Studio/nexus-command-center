// v1.22 (limecore#122, Design H) — AI on the user's own key.
//
// The request goes from this device straight to Google's Gemini API, on a key
// the user supplies, and never through Limecore's servers (the old
// `ai-generate` function, which held the owner's key, is retired). No key, no
// request. One provider for now (Gemini); `generate` is the single entry point
// so another can be added behind it.
//
// The key is stored on the device in Preferences under the `apikey_` prefix,
// like the Finnhub keys: never synced, never sent anywhere but Google, and
// left out of "Export my data" (only allowlisted preference keys go in). It
// belongs to whoever is signed in: sign-out clears it (useSessionStore).
//
// Google's API answers browser requests (CORS) with the key in the
// `x-goog-api-key` header, so the web, desktop and Android editions all call
// it directly; index.html's content security policy allows the host.

import { Preferences } from '@capacitor/preferences';

export const AI_HOST = 'https://generativelanguage.googleapis.com';
/** Editable in Settings: when Google retires a model, a user on an old
 *  version can type the new name instead of waiting for an update. The
 *  default is the model `ai-generate` ran last (limecore#60): Google's 2.5
 *  models no longer serve new projects, so a 2.5 default fails on a new key.
 *  Same as LimeLog's (LimeLog#172). */
export const DEFAULT_AI_MODEL = 'gemini-3.5-flash-lite';

const KEY_PREF = 'apikey_gemini';
const MODEL_PREF = 'ai.model';

async function readPref(key: string): Promise<string | null> {
  try {
    return (await Preferences.get({ key })).value ?? null;
  } catch {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }
}

async function writePref(key: string, value: string | null): Promise<void> {
  try {
    if (value == null) await Preferences.remove({ key });
    else await Preferences.set({ key, value });
  } catch {
    try {
      if (value == null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch {
      /* no storage */
    }
  }
}

export const getAiKey = () => readPref(KEY_PREF);
export const setAiKey = (key: string) => writePref(KEY_PREF, key.trim() || null);
export const clearAiKey = () => writePref(KEY_PREF, null);
export async function getAiModel(): Promise<string> {
  return (await readPref(MODEL_PREF))?.trim() || DEFAULT_AI_MODEL;
}
export const setAiModel = (model: string) => writePref(MODEL_PREF, model.trim() || null);

/** Why a request failed, each with its own message: with the user's own key,
 *  the user is the one who can fix it. */
export type AiError = 'no-key' | 'invalid-key' | 'quota' | 'model' | 'network' | 'other';
export type AiResult = { ok: true; text: string } | { ok: false; error: AiError };

/** Maps Google's answer to an AiError. Exported for the tests. */
export function classifyAiError(status: number, message: string): AiError {
  if (status === 401 || status === 403 || /api key not valid|API_KEY_INVALID|permission/i.test(message)) return 'invalid-key';
  if (status === 429 || /quota|RESOURCE_EXHAUSTED/i.test(message)) return 'quota';
  if (status === 404 || /not found|is not supported/i.test(message)) return 'model';
  return 'other';
}

/** The generation settings `ai-generate` used, moved here with the call
 *  (limecore#60), the same as LimeLog's. 3.x: lowest thinking level and no
 *  temperature (deprecated there, and sending thinkingBudget too is a 400);
 *  2.x: the old settings. Thinking counts against maxOutputTokens, so it stays
 *  at the minimum or a small cap returns only a few words. Exported for the
 *  tests. */
export function generationConfig(model: string, maxTokens: number, temperature: number, json = false): Record<string, unknown> {
  const config: Record<string, unknown> = /^gemini-2\./.test(model)
    ? { temperature, maxOutputTokens: maxTokens, thinkingConfig: { thinkingBudget: 0 } }
    : { maxOutputTokens: maxTokens, thinkingConfig: { thinkingLevel: 'MINIMAL' } };
  if (json) config.responseMimeType = 'application/json';
  return config;
}

export async function generate(opts: {
  prompt: string;
  maxTokens: number;
  temperature: number;
  /** For the Settings test: a key not saved yet. */
  key?: string;
  model?: string;
  fetchImpl?: typeof fetch;
}): Promise<AiResult> {
  const key = (opts.key ?? (await getAiKey()))?.trim();
  if (!key) return { ok: false, error: 'no-key' };
  const model = opts.model?.trim() || (await getAiModel());
  const doFetch = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(`${AI_HOST}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: opts.prompt }] }],
        generationConfig: generationConfig(model, opts.maxTokens, opts.temperature),
      }),
    });
  } catch {
    return { ok: false, error: 'network' };
  }
  let body: { candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[]; error?: { message?: string } } = {};
  try {
    body = await res.json();
  } catch {
    /* not JSON */
  }
  if (!res.ok) return { ok: false, error: classifyAiError(res.status, body.error?.message ?? '') };
  // Thought parts are the model's reasoning, not the answer.
  const text = (body.candidates?.[0]?.content?.parts ?? []).filter((p) => !p.thought).map((p) => p.text ?? '').join('').trim();
  return text ? { ok: true, text } : { ok: false, error: 'other' };
}
