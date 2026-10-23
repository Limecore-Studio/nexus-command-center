// ─── v1.2 Life patterns full screen (v1.5 profile-aware) ────────────────
//
// Three sections:
//   1. THIS WEEK — big life-score ring + composite number, with one sub-score
//      card PER enabled domain of the active Life Profile (v1.5). The ring's
//      segments are sized to each domain's weight.
//   2. PATTERNS — all observations from buildCrossDomainReport as cards.
//   3. HISTORY — horizontal scroll of the last 8 weeks' life scores.
//
// Empty/baseline state when <4 weeks of data unchanged.
//
// v1.5 — the Work domain is NCC-native; its score blends the daily
// self-assessment (50%), logging consistency (20%), active-goal progress
// (20%), and work-life habit completion (10%). Only profiles that enable Work
// surface its card.

import { useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import AppHeader from '../components/AppHeader';
import LifeScoreRing, { type RingSegment } from '../components/LifeScoreRing';
import LifeNarrativeCard from '../components/LifeNarrativeCard';
import DomainTrendGrid, { DOMAIN_COLOURS } from '../components/DomainTrendGrid';
import { useShellTier } from '../lib/useShell';
import { useFinanceStore } from '../store/useFinanceStore';
import { useFitnessStore } from '../store/useFitnessStore';
import { useStudiesStore } from '../store/useStudiesStore';
import { useHabitsStore } from '../store/useHabitsStore';
import { useTaskStore } from '../store/useTaskStore';
import { useGoalsStore } from '../store/useGoalsStore';
import { useWorkQualityStore } from '../store/useWorkQualityStore';
import { useLifeProfileStore } from '../store/useLifeProfileStore';
import { useSettingsStore } from '../store/useSettingsStore';
import {
  buildCrossDomainReport,
  bucketHabitsByWeek,
  lastNWeeks,
  startOfWeek,
  type Insight,
  type LifeScore,
} from '../lib/crossDomainSignals';
import { computeWorkScore, weeklyRatingStats } from '../lib/workScore';
import { computeGoalProgress, type DataSources } from '../lib/goals';
import {
  enabledDomains,
  weeklyTargetFor,
  currentWeeklyTarget,
  withWeeklyTargetOverride,
  MIN_WEEKLY_WORKOUT_TARGET,
  MAX_WEEKLY_WORKOUT_TARGET,
  type DomainKey,
} from '../lib/lifeProfile';
import { dateKey } from '../lib/habitStreaks';
import HabitsDashboardStrip from '../components/HabitsDashboardStrip';
import { DOMAIN } from '../lib/themeColors';

const TONE_BORDER: Record<Insight['tone'], string> = {
  positive: 'border-success/40',
  negative: 'border-warning/40',
  neutral: 'border-primary/40',
};
const TONE_TEXT: Record<Insight['tone'], string> = {
  positive: 'text-success',
  negative: 'text-warning',
  neutral: 'text-primary',
};
const TONE_GLYPH: Record<Insight['tone'], string> = {
  positive: '↑',
  negative: '↓',
  neutral: '◌',
};
const DOMAIN_LABEL_KEY: Record<Insight['domain'], string> = {
  'fitness-study': 'life.xFitnessStudy',
  'fitness-finance': 'life.xFitnessFinance',
  'habits-output': 'life.xHabitsOutput',
  'life-score': 'life.lifeScoreLabel',
};

// Per-domain ring/card accent + which LifeScore field holds its sub-score.
const DOMAIN_COLOR: Record<DomainKey, string> = {
  finance: DOMAIN.finance,
  fitness: DOMAIN.fitness,
  studies: DOMAIN.study,
  work: DOMAIN.work,
  habits: DOMAIN.habits,
};
const DOMAIN_SUBSCORE: Record<DomainKey, keyof Pick<LifeScore, 'workouts' | 'study' | 'habits' | 'budget' | 'work'>> = {
  finance: 'budget',
  fitness: 'workouts',
  studies: 'study',
  work: 'work',
  habits: 'habits',
};

export default function Life() {
  const { t } = useTranslation();
  const txns = useFinanceStore((s) => s.transactions);
  const budgets = useFinanceStore((s) => s.budgetCategories);
  const workouts = useFitnessStore((s) => s.sessions);
  const studies = useStudiesStore((s) => s.studySessions);
  const currentImport = useStudiesStore((s) => s.currentImport);
  const gradeScale = useStudiesStore((s) => s.gradeScale);
  const habits = useHabitsStore((s) => s.habits);
  const completions = useHabitsStore((s) => s.completions);
  const tasks = useTaskStore((s) => s.tasks);
  const goals = useGoalsStore((s) => s.goals);
  const workLogs = useWorkQualityStore((s) => s.logs);
  const loadWork = useWorkQualityStore((s) => s.load);
  const workLoaded = useWorkQualityStore((s) => s.loaded);
  const profile = useLifeProfileStore((s) => s.profile);
  const aiEnabled = useSettingsStore((s) => s.aiEnabled);
  const loadProfile = useLifeProfileStore((s) => s.load);
  const setProfile = useLifeProfileStore((s) => s.setProfile);

  // v1.9 (Item 3) — this week's workout target, adjustable for this week only.
  // The baseline lives in Life Profile settings; this is the "sick week, don't
  // judge me by my usual" escape hatch, and it touches no other week.
  const thisWeekKey = dateKey(startOfWeek(new Date()));
  const weekTarget = weeklyTargetFor(profile, thisWeekKey);
  const baselineTarget = currentWeeklyTarget(profile);
  const onWeekTarget = (next: number) => {
    // Setting it back to the baseline clears the override rather than storing a
    // redundant entry, so the map only ever holds genuine exceptions.
    void setProfile(
      withWeeklyTargetOverride(profile, thisWeekKey, next === baselineTarget ? null : next),
    );
  };

  useEffect(() => {
    if (!workLoaded) void loadWork();
    void loadProfile();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Work score (only meaningful when the profile enables Work) ─────────
  const workScore = useMemo(() => {
    const { weeklyRatingAvg, daysLoggedThisWeek } = weeklyRatingStats(workLogs);

    // Active-goal progress: average of clamped per-goal % across incomplete
    // goals. DataSources is assembled from the stores that the relevant goal
    // types read; portfolio-valuation fields are left empty (net_worth goals
    // then read 0 — accepted, since Work weights goals only 20%).
    const activeGoals = goals.filter((g) => !g.completed && !g.deletedAt);
    let goalsProgressPct = 0;
    if (activeGoals.length > 0) {
      const ds: DataSources = {
        transactions: txns,
        holdings: [],
        manualAssets: [],
        stockQuotes: [],
        cryptoPrices: null,
        fxRates: null,
        baseCurrency: 'EUR',
        tasks,
        studySessions: studies,
        workouts: workouts as DataSources['workouts'],
        currentGpa: currentImport?.calculatedGpa ?? null,
        gradeScale, // v1.19 (NCC#197)
      };
      const sum = activeGoals.reduce(
        (s, g) => s + Math.min(100, Math.max(0, computeGoalProgress(g, ds).percent)),
        0,
      );
      goalsProgressPct = sum / activeGoals.length;
    }

    // Work-life habit completion: current-week habit hit ratio.
    const habitWeek = bucketHabitsByWeek(habits, completions, lastNWeeks(1))[0];
    const workLifeHabitsPct = habitWeek?.hitRatio != null ? habitWeek.hitRatio * 100 : 0;

    return computeWorkScore({ weeklyRatingAvg, daysLoggedThisWeek, goalsProgressPct, workLifeHabitsPct });
  }, [workLogs, goals, txns, tasks, studies, workouts, currentImport, gradeScale, habits, completions]);

  const report = useMemo(
    () =>
      buildCrossDomainReport(workouts, studies, txns, budgets, habits, completions, 8, new Date(), {
        profile,
        currentWorkScore: workScore,
        workHasData: workLogs.length > 0,
      }),
    [workouts, studies, txns, budgets, habits, completions, profile, workScore, workLogs.length],
  );

  const historyScrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = historyScrollRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [report.weeks.lifeScores.length]);

  const thisWeek = report.weeks.lifeScores[0];

  // v1.9 Item 14b #8 — the same report, re-read as five aligned series.
  // The report's weekly arrays run newest-first (lifeScores[0] is this week);
  // a time axis reads left-to-right oldest-first, so they are reversed once
  // here rather than in the component, which should not have to know.
  const isDesktop = useShellTier() === 'desktop';
  const crossDomain = useMemo(() => {
    const w = report.weeks;
    const order = <T,>(arr: T[]) => [...arr].reverse();
    const lifeScores = order(w.lifeScores);
    const fitness = order(w.fitness);
    const study = order(w.study);
    const habitsW = order(w.habits);
    const finance = order(w.finance);
    const pct = (v: number) => `${Math.round(v)}%`;
    return {
      weekStarts: lifeScores.map((s) => s.weekStart),
      series: [
        {
          key: 'life',
          label: t('life.lifeScoreLabel'),
          colour: DOMAIN_COLOURS.life,
          values: lifeScores.map((s) => s.score),
          max: 100,
          format: (v: number) => String(Math.round(v)),
        },
        {
          key: 'fitness',
          label: t('domains.fitness'),
          colour: DOMAIN_COLOURS.fitness,
          values: fitness.map((f) => f.sessionsCount),
          format: (v: number) => t('fin.dtg.sessions', { count: Math.round(v) }),
        },
        {
          key: 'study',
          label: t('domains.studies'),
          colour: DOMAIN_COLOURS.study,
          values: study.map((s) => s.totalMinutes),
          format: (v: number) => t('fin.dtg.minutes', { count: Math.round(v) }),
        },
        {
          key: 'habits',
          label: t('domains.habits'),
          colour: DOMAIN_COLOURS.habits,
          // null stays null: a week with no eligible habit is not a 0% week.
          values: habitsW.map((h) => (h.hitRatio == null ? null : h.hitRatio * 100)),
          max: 100,
          format: pct,
        },
        {
          key: 'finance',
          label: t('domains.finance'),
          colour: DOMAIN_COLOURS.finance,
          values: finance.map((f) => (f.budgetAdherence == null ? null : f.budgetAdherence * 100)),
          // 100% is exactly on plan; the reference line is the whole point of
          // this row, since above it is overspend and below it is headroom.
          reference: 100,
          format: pct,
        },
      ],
    };
  }, [report, t]);
  const domains = enabledDomains(profile);

  // Ring shows only domains that were measured this week (have data) — matching
  // the composite, which excludes un-engaged domains rather than scoring them 0.
  const ringSegments: RingSegment[] = useMemo(
    () =>
      domains
        .filter((k) => thisWeek?.measured[k])
        .map((k) => ({
          key: k,
          score: thisWeek ? thisWeek[DOMAIN_SUBSCORE[k]] : 0,
          weight: profile.domains[k],
          color: DOMAIN_COLOR[k],
        })),
    [domains, profile, thisWeek],
  );

  // Work card sub-line ("Avg X/5 · Y days").
  const workStats = useMemo(() => weeklyRatingStats(workLogs), [workLogs]);

  return (
    <>
      <AppHeader title={t('life.title')} back="/" backLabel={t('nav.home')} showAvatar={false} />
      <div className="space-y-6">
        {/* ─── THIS WEEK ─────────────────────────────────────────────── */}
        <section className="space-y-3">
          <h2 className="font-heading font-semibold text-xs uppercase tracking-wider text-text-muted px-1">
            {t('life.thisWeek')}
          </h2>
          {!report.ready ? (
            <div className="panel p-6 text-center">
              <div className="font-heading text-base font-semibold mb-1">{t('life.buildingBaseline')}</div>
              <div className="text-xs text-text-muted">
                {t('life.buildingBaselineSub')}
              </div>
            </div>
          ) : (
            <div className="panel p-4 flex flex-col items-center">
              <LifeScoreRing segments={ringSegments} size={200}>
                <div className="flex flex-col items-center leading-none">
                  <span className="font-heading text-5xl font-bold">{thisWeek.score}</span>
                  <span className="text-[0.625rem] uppercase tracking-wider text-text-muted mt-1">{t('domains.lifeScore')}</span>
                </div>
              </LifeScoreRing>
              <div className="grid grid-cols-2 gap-2 w-full mt-4">
                {domains.map((k) => {
                  const measured = thisWeek.measured[k];
                  return (
                    <DomainCard
                      key={k}
                      domain={k}
                      score={thisWeek[DOMAIN_SUBSCORE[k]]}
                      measured={measured}
                      sub={
                        !measured
                          ? t('life.notCountedYet')
                          : k === 'work'
                            ? workStats.daysLoggedThisWeek > 0
                              ? t('life.avgRating', { avg: workStats.weeklyRatingAvg.toFixed(1), count: workStats.daysLoggedThisWeek, unit: workStats.daysLoggedThisWeek === 1 ? t('life.day') : t('life.days') })
                              : t('life.noRatingsYet')
                            : undefined
                      }
                    />
                  );
                })}
              </div>

              {/* Per-week workout target. Only where Fitness actually counts —
                  a profile with fitness at 0 has no use for it. */}
              {domains.includes('fitness') && (
                <div className="w-full mt-3 flex items-center justify-between gap-3 px-1">
                  <div className="min-w-0">
                    <div className="text-[0.6875rem] text-text-muted">
                      {t('life.weekTarget')}
                    </div>
                    {weekTarget !== baselineTarget && (
                      <div className="text-[0.625rem] text-warning">
                        {t('life.weekTargetAdjusted', { baseline: baselineTarget })}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <button
                      type="button"
                      className="btn-ghost w-8 h-8 flex items-center justify-center text-base leading-none"
                      aria-label={t('life.weekTargetLess')}
                      disabled={weekTarget <= MIN_WEEKLY_WORKOUT_TARGET}
                      onClick={() => onWeekTarget(weekTarget - 1)}
                    >
                      −
                    </button>
                    <span className="text-sm tabular-nums w-5 text-center" aria-live="polite">
                      {weekTarget}
                    </span>
                    <button
                      type="button"
                      className="btn-ghost w-8 h-8 flex items-center justify-center text-base leading-none"
                      aria-label={t('life.weekTargetMore')}
                      disabled={weekTarget >= MAX_WEEKLY_WORKOUT_TARGET}
                      onClick={() => onWeekTarget(weekTarget + 1)}
                    >
                      +
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </section>

        {/* ─── HABITS (v1.15 Item 10) ───────────────────────────────────
             Habits had no home in the tab bar; its only way in was the strip
             on Home. Life is where habit completion already feeds the score,
             so the same strip nests here too (and the Life tab stays lit on
             /habits), rather than Habits getting a tab of its own. */}
        <section className="space-y-3">
          <h2 className="font-heading font-semibold text-xs uppercase tracking-wider text-text-muted px-1">
            {t('domains.habits')}
          </h2>
          <HabitsDashboardStrip />
        </section>

        {/* v1.9 Item 14 — desktop arrangement. THIS WEEK stays full width
            above: it is the hero of the screen and its score ring plus domain
            breakdown is one composition, not something to split. The three
            supporting sections below tile two-up at `desktop:` instead of
            running down a very long single column. Below 1201px this wrapper
            is a plain `space-y-6` stack, identical to before. */}
        <div className="space-y-6 desktop:space-y-0 desk-grid">
        {/* ─── AI NARRATIVE ─────────────────────────────────────────── */}
        {/* Gated on the Settings opt-in. Off by default — this card used to
            generate itself on arrival, which is not what "opt-in" means. */}
        {aiEnabled && report.ready && thisWeek && (
          <LifeNarrativeCard
            input={{
              lifeScore: thisWeek.score,
              workouts: thisWeek.workouts,
              study: thisWeek.study,
              habits: thisWeek.habits,
              budget: thisWeek.budget,
              work: thisWeek.work,
              profile,
              insightHeadlines: report.insights.map((i) => i.headline),
            }}
          />
        )}

        {/* ─── PATTERNS ─────────────────────────────────────────────── */}
        {report.ready && (
          <section className="space-y-2 desk-fill">
            <h2 className="font-heading font-semibold text-xs uppercase tracking-wider text-text-muted px-1">
              {t('life.patterns')}
            </h2>
            {report.insights.length === 0 ? (
              <div className="panel-2 p-4 text-center text-xs text-text-muted">
                {t('life.patternsEmpty')}
              </div>
            ) : (
              <div className="space-y-2 stagger-children">
                {report.insights.map((ins) => (
                  <article key={ins.id} className={`panel p-4 border-s-2 ${TONE_BORDER[ins.tone]}`}>
                    <div className="text-[0.625rem] uppercase tracking-wider text-text-muted mb-1">
                      {t(DOMAIN_LABEL_KEY[ins.domain])}
                    </div>
                    <div className={`font-heading text-base font-bold leading-tight ${TONE_TEXT[ins.tone]} mb-1`}>
                      <span aria-hidden className="me-1">{TONE_GLYPH[ins.tone]}</span>
                      {ins.headline}
                    </div>
                    <div className="text-xs text-text-muted">{ins.detail}</div>
                  </article>
                ))}
              </div>
            )}
          </section>
        )}

        {/* ─── CROSS-DOMAIN (v1.9 Item 14b #8, desktop only) ────────── */}
        {isDesktop && report.ready && (
          <section className="space-y-2 desk-span desk-fill">
            <h2 className="font-heading font-semibold text-xs uppercase tracking-wider text-text-muted px-1">
              {t('fin.dtg.title')}
            </h2>
            <div className="card">
              <DomainTrendGrid weekStarts={crossDomain.weekStarts} series={crossDomain.series} />
            </div>
          </section>
        )}

        {/* ─── HISTORY ─────────────────────────────────────────────── */}
        {report.ready && (
          <section className="space-y-2 desk-fill">
            <h2 className="font-heading font-semibold text-xs uppercase tracking-wider text-text-muted px-1">
              {t('life.history')}
            </h2>
            <div ref={historyScrollRef} className="flex gap-2 overflow-x-auto no-scrollbar px-1 stagger-children">
              {[...report.weeks.lifeScores].reverse().map((w) => (
                <div key={w.weekStart} className="panel-2 p-3 flex-shrink-0 w-20 flex flex-col items-center">
                  <div className="text-[0.5625rem] uppercase tracking-wider text-text-muted">{w.weekStart.slice(5)}</div>
                  <div className="font-heading text-xl font-bold mt-1">{w.score}</div>
                  <div className="text-[0.5625rem] text-text-muted mt-0.5">{t('life.per100')}</div>
                </div>
              ))}
            </div>
          </section>
        )}
        </div>

        <div className="text-[0.625rem] text-text-muted text-center">
          {t('life.footer')}
        </div>
      </div>
    </>
  );
}

function DomainCard({ domain, score, sub, measured = true }: { domain: DomainKey; score: number; sub?: string; measured?: boolean }) {
  const { t } = useTranslation();
  // The work tile used to get a pink wash on top of its pink domain dot, which
  // said the same thing twice and put a sixth surface colour on the screen.
  // The dot carries domain identity; the tile is just a panel.
  return (
    <div className={`panel p-3 ${measured ? '' : 'opacity-60'}`}>
      <div className="flex items-center gap-1.5">
        <span aria-hidden className="w-2 h-2 rounded-full" style={{ background: measured ? DOMAIN_COLOR[domain] : 'rgba(169,174,180,0.4)' }} />
        <div className="sec">{t(`domains.${domain}`)}</div>
      </div>
      <div className="readout mt-1 text-xl">{measured ? score : '—'}</div>
      {sub && <div className="text-[0.625rem] text-text-muted mt-0.5">{sub}</div>}
    </div>
  );
}
