// Life narrative card — v1.4. Sits on the Life tab between the score ring and
// the Patterns list. Shows a short AI-written summary of the week, generated
// by Gemini on the user's own key (lib/aiProvider, v1.22). Cached in Dexie and
// regenerated when the life score drifts ≥5 points, or on manual refresh.
//
// Degrades to nothing: if generation returns null (AI not configured, offline,
// blocked) and there's no cached text, the card renders empty — no clutter.

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { db } from '../db/database';
import { generateLifeNarrative, type NarrativeInput } from '../lib/aiNarrative';
import type { AiError } from '../lib/aiProvider';
import Glyph from './Glyph';

const DRIFT_THRESHOLD = 5;
const NARRATIVE_ID = 1;

export default function LifeNarrativeCard({ input }: { input: NarrativeInput }) {
  const { t } = useTranslation();
  const [text, setText] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  // v1.22 (limecore#122): why it failed, when the user can fix it.
  const [aiError, setAiError] = useState<AiError | null>(null);
  // Avoid duplicate generations for the same score within one mount.
  const lastGeneratedScore = useRef<number | null>(null);

  async function generate(force = false) {
    if (loading) return;
    setLoading(true);
    setFailed(false);
    setAiError(null);
    const out = await generateLifeNarrative(input);
    const result = out && 'text' in out ? out.text : null;
    if (out && 'error' in out) setAiError(out.error);
    if (result) {
      setText(result);
      lastGeneratedScore.current = input.lifeScore;
      void db.lifeNarrative.put({
        id: NARRATIVE_ID,
        text: result,
        generatedAt: new Date().toISOString(),
        lifeScore: input.lifeScore,
      });
    } else {
      setFailed(true);
      // Keep any prior text on failure unless this was a forced manual retry
      // with nothing cached.
      if (force && !text) setText(null);
    }
    setLoading(false);
  }

  // On mount / when the life score shifts: hydrate cache, then (re)generate if
  // there's no cache or the score has drifted past the threshold.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const cached = await db.lifeNarrative.get(NARRATIVE_ID);
      if (cancelled) return;
      if (cached) {
        setText(cached.text);
        lastGeneratedScore.current = cached.lifeScore;
      }
      const drift = cached ? Math.abs(cached.lifeScore - input.lifeScore) : Infinity;
      if (!cached || drift >= DRIFT_THRESHOLD) {
        void generate();
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input.lifeScore]);

  // Nothing to show and nothing happening → render empty (graceful absence),
  // unless a request failed for a reason the user can fix (v1.22).
  if (!text && !loading && !aiError) return null;

  return (
    <div className="panel p-4 border-s-2 border-primary/40">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[0.625rem] uppercase tracking-wider text-text-muted flex items-center gap-1.5">
          <Glyph name="sparkle" size={11} className="text-primary" /> This week, in a nutshell
        </span>
        <span className="flex items-center gap-1.5">
          <span className="text-[0.5rem] uppercase tracking-[0.15em] text-primary border border-primary/40 rounded-sm px-1 py-0.5">
            AI
          </span>
          {text && (
            <button
              type="button"
              onClick={() => generate(true)}
              disabled={loading}
              aria-label={t('life.narrativeRegenerate')}
              className="text-[0.6875rem] text-text-muted active:text-text disabled:opacity-40"
            >
              ↻
            </button>
          )}
        </span>
      </div>

      {loading && !text ? (
        <div className="space-y-1.5" aria-hidden>
          <div className="h-3 rounded-sm bg-surface2 animate-pulse" />
          <div className="h-3 rounded-sm bg-surface2 animate-pulse w-[92%]" />
          <div className="h-3 rounded-sm bg-surface2 animate-pulse w-[70%]" />
        </div>
      ) : (
        <p className="text-sm leading-relaxed text-text">
          {text}
          {loading && <span className="text-text-muted"> · refreshing…</span>}
        </p>
      )}

      {failed && !text && (
        <button
          type="button"
          onClick={() => generate(true)}
          className="text-[0.6875rem] text-text-muted active:text-text mt-1"
        >
          Couldn't generate a summary — tap to retry
        </button>
      )}

      {aiError && (
        <div role="status" className="text-[0.625rem] text-warning mt-2">
          {t(`ai.err.${aiError}`)}
        </div>
      )}
      <div className="text-[0.5625rem] text-text-muted mt-2">
        {t('life.narrativeFootnote')}
      </div>
    </div>
  );
}
