// ─── v1.2 Cross-Domain Insights dashboard card ──────────────────────────
//
// Lightweight summary card for the Dashboard. Renders either:
//   - "Building your baseline" state when <4 weeks of data
//   - A rotating insight (one at a time, cycles every 6s)
//   - "Patterns are quiet this week" copy when ready but no insights cross
//     the 15% delta threshold
//
// Tap → /life for the full screen.
//
// Rotation: useEffect with setInterval, advancing through the available
// insights. We pause rotation while the user is interacting (touch/focus)
// — the natural readability hesitation should pause the card so the user
// can finish reading.

import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useFinanceStore } from '../store/useFinanceStore';
import { useFitnessStore } from '../store/useFitnessStore';
import { useStudiesStore } from '../store/useStudiesStore';
import { useHabitsStore } from '../store/useHabitsStore';
import { useSessionStore } from '../store/useSessionStore';
import { buildCrossDomainReport, type Insight } from '../lib/crossDomainSignals';

const ROTATE_MS = 6000;

const TONE_TINT: Record<Insight['tone'], string> = {
  positive: 'text-success',
  negative: 'text-warning',
  neutral: 'text-primary',
};

const TONE_GLYPH: Record<Insight['tone'], string> = {
  positive: '↑',
  negative: '↓',
  neutral: '◌',
};

export default function CrossDomainCard() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const txns = useFinanceStore((s) => s.transactions);
  const budgets = useFinanceStore((s) => s.budgetCategories);
  const userId = useSessionStore((s) => s.user?.id);
  const workouts = useFitnessStore((s) => s.sessions);
  const studies = useStudiesStore((s) => s.studySessions);
  const habits = useHabitsStore((s) => s.habits);
  const completions = useHabitsStore((s) => s.completions);

  const report = useMemo(
    () =>
      // v1.22 (NCC#253): a budget shared to this user is not theirs.
      buildCrossDomainReport(workouts, studies, txns, budgets, habits, completions, 8, new Date(), { userId }),
    [workouts, studies, txns, budgets, habits, completions, userId],
  );

  const [idx, setIdx] = useState(0);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (paused) return;
    if (report.insights.length <= 1) return;
    const t = setInterval(() => {
      setIdx((i) => (i + 1) % report.insights.length);
    }, ROTATE_MS);
    return () => clearInterval(t);
  }, [paused, report.insights.length]);

  // HYG-4 — was an effect that corrected `idx` after the fact. Derived instead:
  // when the insight set shrinks, the stored index points past the end for
  // exactly one render, and the effect's own re-render was what fixed it. The
  // clamp here removes both that frame and the extra render.
  const safeIdx = idx < report.insights.length ? idx : 0;

  // Baseline-building state — <4 weeks of activity.
  if (!report.ready) {
    return (
      <button
        type="button"
        onClick={() => navigate('/life')}
        className="panel p-4 text-start w-full press-spring"
      >
        <div className="flex items-center justify-between mb-1">
          <h2 className="font-heading font-semibold text-sm">{t('dash.lifePatterns')}</h2>
          <span className="text-[0.625rem] text-text-muted uppercase tracking-wider">
            {t('dash.buildingBaseline')}
          </span>
        </div>
        <p className="text-[0.6875rem] text-text-muted">
          {t('dash.baselineBody')}
        </p>
      </button>
    );
  }

  // Ready but no insights pass the 15% threshold — patterns quiet.
  if (report.insights.length === 0) {
    return (
      <button
        type="button"
        onClick={() => navigate('/life')}
        className="panel p-4 text-start w-full press-spring"
      >
        <div className="flex items-center justify-between mb-1">
          <h2 className="font-heading font-semibold text-sm">{t('dash.lifePatterns')}</h2>
          <span className="text-[0.625rem] text-text-muted uppercase tracking-wider">
            {t('dash.quietWeek')}
          </span>
        </div>
        <p className="text-[0.6875rem] text-text-muted">
          {t('dash.quietBody')}
        </p>
      </button>
    );
  }

  const insight = report.insights[safeIdx] ?? report.insights[0];
  return (
    <button
      type="button"
      onClick={() => navigate('/life')}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
      className="panel p-4 text-start w-full press-spring"
      aria-label={t('dash.openLifePatterns')}
    >
      <div className="flex items-center justify-between mb-2">
        <h2 className="font-heading font-semibold text-sm">{t('dash.lifePatterns')}</h2>
        {report.insights.length > 1 && (
          <div className="flex gap-1" aria-hidden>
            {report.insights.map((_, i) => (
              <span
                key={i}
                className={`block w-1.5 h-1.5 rounded-full transition-colors ${
                  i === safeIdx ? 'bg-primary' : 'bg-text-muted/30'
                }`}
              />
            ))}
          </div>
        )}
      </div>
      <div
        key={insight.id}
        className="animate-fade-in-up"
      >
        <div className={`text-2xl ${TONE_TINT[insight.tone]} font-heading font-bold leading-tight mb-1`}>
          <span aria-hidden className="me-1">{TONE_GLYPH[insight.tone]}</span>
          {insight.headline}
        </div>
        <div className="text-[0.6875rem] text-text-muted">{insight.detail}</div>
      </div>
    </button>
  );
}
