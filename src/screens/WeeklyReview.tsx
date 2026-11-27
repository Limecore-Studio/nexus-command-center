// Cross-module weekly summary. Pulls aggregations from each module's store
// (via the buildWeeklyReview helper) and renders a one-screen recap.
//
// Layout:
//   - Header with the week range and a Prev/Next stepper
//   - Insights bullets (cross-module observations) at the top — these are
//     the most "newsworthy" items, so they get prime real estate
//   - 4 module cards (Finance / Studies / Fitness / Tasks) with their
//     biggest numbers + a deltaLabel vs last week
//   - Footer note explaining the Sunday notification + link to Settings
//
// The screen is fully derived data — no Dexie writes. Each card tap routes
// to that module's overview so the user can drill in.

import { useEffect, useMemo, useState } from 'react';
import { formatLocale, formatShortDate, localDateKey } from '../utils/formatters';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import AppHeader from '../components/AppHeader';
import { useFinanceStore } from '../store/useFinanceStore';
import { useStudiesStore } from '../store/useStudiesStore';
import { useFitnessStore } from '../store/useFitnessStore';
import { useTaskStore } from '../store/useTaskStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { useHabitsStore } from '../store/useHabitsStore';
import { useSessionStore } from '../store/useSessionStore';
import { db } from '../db/database';
import type { RecurringRule } from '../types/recurring';
import { buildWeeklyReview, startOfWeek } from '../lib/weeklyReview';
import { buildWeeklyExtras } from '../lib/weeklyExtras';
import { daysUntil, fetchStudyDeadlines, type StudyDeadline } from '../lib/studyDeadlines';
import { RackLevels, RackLog, type LevelRow } from '../components/RackWeekly';
import { useActiveTheme } from '../lib/theme';
import Glyph from '../components/Glyph';
import SuiteAppLink from '../components/SuiteAppLink';

function formatRange(start: Date, end: Date): string {
  const sameMonth = start.getMonth() === end.getMonth();
  const day = (d: Date) => d.getDate();
  const month = (d: Date) =>
    new Intl.DateTimeFormat(formatLocale(), { month: 'short' }).format(d);
  const year = (d: Date) => d.getFullYear();
  if (sameMonth) {
    return `${day(start)}–${day(end)} ${month(end)} ${year(end)}`;
  }
  return `${day(start)} ${month(start)} – ${day(end)} ${month(end)} ${year(end)}`;
}

function formatHours(min: number): string {
  if (min <= 0) return '0';
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

const TONE_STYLES = {
  positive: 'border-success/40 bg-success/5 text-success',
  warn: 'border-warning/40 bg-warning/5 text-warning',
  neutral: 'border-border bg-surface2/40 text-text-muted',
};

export default function WeeklyReview() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const transactions = useFinanceStore((s) => s.transactions);
  const budgetCategories = useFinanceStore((s) => s.budgetCategories);
  const holdings = useFinanceStore((s) => s.holdings);
  const courses = useStudiesStore((s) => s.courses);
  const studySessions = useStudiesStore((s) => s.studySessions);
  const currentImport = useStudiesStore((s) => s.currentImport);
  const workouts = useFitnessStore((s) => s.sessions);
  const tasks = useTaskStore((s) => s.tasks);
  const baseCurrency = useSettingsStore((s) => s.baseCurrency);
  // v1.22 (NCC#278): the suite view's extra inputs.
  const habits = useHabitsStore((s) => s.habits);
  const completions = useHabitsStore((s) => s.completions);
  const userId = useSessionStore((s) => s.user?.id);
  const [rules, setRules] = useState<RecurringRule[]>([]);
  useEffect(() => {
    void db.recurringRules.toArray().then(setRules).catch(() => setRules([]));
  }, []);

  // Allow stepping backwards through prior weeks (useful for catching up on
  // a missed Sunday). +N moves forward; we clamp at the current week so the
  // user can't peek into the future.
  const [weekOffset, setWeekOffset] = useState(0);
  const currentWeekStart = useMemo(() => {
    const base = startOfWeek();
    base.setDate(base.getDate() + weekOffset * 7);
    return base;
  }, [weekOffset]);

  const data = useMemo(
    () =>
      buildWeeklyReview({
        weekStart: currentWeekStart,
        transactions,
        courses,
        sessions: studySessions,
        workouts,
        tasks,
        currentGpa: currentImport?.calculatedGpa ?? null,
        holdings,
      }),
    [
      currentWeekStart,
      transactions,
      courses,
      studySessions,
      workouts,
      tasks,
      currentImport,
      holdings,
    ],
  );
  // v1.22 (NCC#278): the suite view (lib/weeklyExtras).
  // v1.22 (NCC#278): exams and assignments from StudyDesk, read on demand for
  // the current week (lib/studyDeadlines; NCC only reads them).
  const [deadlines, setDeadlines] = useState<StudyDeadline[]>([]);
  const today = localDateKey(new Date());
  useEffect(() => {
    // Shown only for the current week and a signed-in user, so other cases
    // need no fetch (and no clearing).
    if (weekOffset !== 0 || !userId) return;
    const end = new Date(currentWeekStart);
    end.setDate(end.getDate() + 13);
    let cancelled = false;
    void fetchStudyDeadlines(userId, today, localDateKey(end)).then((d) => {
      if (!cancelled) setDeadlines(d);
    });
    return () => {
      cancelled = true;
    };
  }, [weekOffset, userId, currentWeekStart, today]);
  const dueLabel = (due: string) => {
    const n = daysUntil(due, today);
    return n <= 0 ? t('weeklyReview.dueToday') : n === 1 ? t('weeklyReview.dueTomorrow') : t('weeklyReview.dueInDays', { count: n });
  };

  const extras = useMemo(
    () =>
      buildWeeklyExtras({
        weekStart: currentWeekStart,
        transactions,
        budgets: budgetCategories,
        userId,
        courses,
        sessions: studySessions,
        workouts,
        habits,
        completions,
        rules,
      }),
    [currentWeekStart, transactions, budgetCategories, userId, courses, studySessions, workouts, habits, completions, rules],
  );

  // v1.15 (Item 13) — Rack's held peak is simply last week's report.
  const rack = useActiveTheme() === 'rack';
  const prior = useMemo(() => {
    if (!rack) return null;
    const start = new Date(currentWeekStart);
    start.setDate(start.getDate() - 7);
    return buildWeeklyReview({
      weekStart: start,
      transactions,
      courses,
      sessions: studySessions,
      workouts,
      tasks,
      currentGpa: currentImport?.calculatedGpa ?? null,
      holdings,
    });
  }, [rack, currentWeekStart, transactions, courses, studySessions, workouts, tasks, currentImport, holdings]);

  const fmtMoney = (amount: number): string =>
    new Intl.NumberFormat(formatLocale(), {
      style: 'currency',
      currency: baseCurrency,
      maximumFractionDigits: 0,
    }).format(amount);

  const topCategoryName = data.finance.topCategoryId
    ? budgetCategories.find((c) => c.id === data.finance.topCategoryId)?.name ?? '—'
    : null;

  return (
    <>
      <AppHeader title={t('weeklyReview.title')} back="/" backLabel={t('nav.home')} showAvatar={false} />
      <div className="space-y-3">
        {/* Week stepper */}
        <div className="card flex items-center justify-between">
          <button
            onClick={() => setWeekOffset((w) => w - 1)}
            className="text-xs px-2 py-1 rounded-sm border border-border text-text-muted active:text-text active:border-border"
          >
            {t('weeklyReview.prev')}
          </button>
          <div className="text-center">
            <div className="text-[0.5625rem] uppercase tracking-[0.2em] text-text-muted">
              {t('weeklyReview.week')}
            </div>
            <div className="font-heading font-semibold text-sm">
              {formatRange(data.weekStart, data.weekEnd)}
            </div>
          </div>
          <button
            onClick={() => setWeekOffset((w) => Math.min(0, w + 1))}
            disabled={weekOffset >= 0}
            className="text-xs px-2 py-1 rounded-sm border border-border text-text-muted active:text-text active:border-border disabled:opacity-30"
          >
            {t('weeklyReview.next')}
          </button>
        </div>

        {rack && prior && (() => {
          const pct = (v: number, p: number) =>
            p > 0 ? `${v >= p ? '+' : '−'}${Math.round((Math.abs(v - p) / p) * 100)}%` : '—';
          const cnt = (v: number, p: number) => (v === p ? '±0' : `${v > p ? '+' : '−'}${Math.abs(v - p)}`);
          const hm = (m: number) => `${Math.floor(m / 60)}h${String(Math.round(m % 60)).padStart(2, '0')}`;
          const rows: LevelRow[] = [
            { key: 'spend', label: t('rack.levelSpend'), value: data.finance.spend, previous: prior.finance.spend,
              display: fmtMoney(data.finance.spend), delta: pct(data.finance.spend, prior.finance.spend), lowerIsBetter: true,
              onClick: () => navigate('/finance') },
            { key: 'study', label: t('rack.levelStudy'), value: data.studies.studyMinutes, previous: prior.studies.studyMinutes,
              display: hm(data.studies.studyMinutes), delta: pct(data.studies.studyMinutes, prior.studies.studyMinutes),
              onClick: () => navigate('/life') },
            { key: 'volume', label: t('rack.levelVolume'), value: data.fitness.totalVolumeKg, previous: prior.fitness.totalVolumeKg,
              display: `${Math.round(data.fitness.totalVolumeKg).toLocaleString(formatLocale())} kg`,
              delta: pct(data.fitness.totalVolumeKg, prior.fitness.totalVolumeKg), onClick: () => navigate('/life') },
            { key: 'tasks', label: t('rack.levelTasks'), value: data.tasks.completed, previous: prior.tasks.completed,
              display: t('rack.tasksDone', { count: data.tasks.completed }), delta: cnt(data.tasks.completed, prior.tasks.completed),
              onClick: () => navigate('/tasks') },
          ];
          return (
            <>
              <RackLevels rows={rows} />
              <RackLog lines={data.insights} />
            </>
          );
        })()}

        {/* Insights */}
        {!rack && data.insights.length > 0 && (
          <div className="card">
            <div className="font-heading font-semibold text-sm mb-2">{t('weeklyReview.highlights')}</div>
            <div className="space-y-1.5">
              {data.insights.map((insight, i) => (
                <div
                  key={i}
                  className={`text-xs px-2 py-1.5 rounded-sm border ${TONE_STYLES[insight.tone]}`}
                >
                  {insight.text}
                </div>
              ))}
            </div>
          </div>
        )}

        {!rack && (<>
        {/* Finance */}
        <button
          onClick={() => navigate('/finance')}
          className="card text-start w-full active:bg-surface2/40"
        >
          <div className="flex items-center justify-between mb-2">
            <span className="font-heading font-semibold text-sm inline-flex items-center gap-1.5"><Glyph name="finance" size={13} className="text-text-muted" />{t('weeklyReview.finance')}</span>
            <span className="text-[0.5625rem] uppercase tracking-wider text-primary border border-primary/40 rounded-sm px-1.5 py-0.5">
              {t('weeklyReview.open')}
            </span>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div>
              <div className="text-[0.5625rem] uppercase tracking-wider text-text-muted">{t('weeklyReview.spend')}</div>
              <div className="font-heading font-bold text-base">{fmtMoney(data.finance.spend)}</div>
              <div className="text-[0.5625rem] text-text-muted">{data.finance.spendDelta}</div>
            </div>
            <div>
              <div className="text-[0.5625rem] uppercase tracking-wider text-text-muted">{t('weeklyReview.income')}</div>
              <div className="font-heading font-bold text-base">{fmtMoney(data.finance.income)}</div>
            </div>
            <div>
              <div className="text-[0.5625rem] uppercase tracking-wider text-text-muted">{t('weeklyReview.tx')}</div>
              <div className="font-heading font-bold text-base">{data.finance.txCount}</div>
            </div>
          </div>
          {topCategoryName && (
            <div className="text-[0.625rem] text-text-muted mt-2">
              {t('weeklyReview.topCategory', { name: topCategoryName, amount: fmtMoney(data.finance.topCategoryAmount) })}
            </div>
          )}
          {/* v1.22 (NCC#278): the Life Score's budget rule, month to date. */}
          {extras.budgetUsed != null && (
            <div className={`text-[0.625rem] mt-1 ${extras.budgetUsed > 1 ? 'text-warning' : 'text-text-muted'}`}>
              {t('weeklyReview.budgetUsed', { pct: Math.round(extras.budgetUsed * 100) })}
            </div>
          )}
        </button>

        {/* Studies — read-only summary (the dedicated screen was removed in
            the v1.3 scope reduction; this stays as a signal recap). */}
        <div className="card">
          <div className="flex items-center justify-between mb-2">
            <span className="font-heading font-semibold text-sm inline-flex items-center gap-1.5"><Glyph name="studies" size={13} className="text-text-muted" />{t('weeklyReview.studies')}</span>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div>
              <div className="text-[0.5625rem] uppercase tracking-wider text-text-muted">{t('weeklyReview.studied')}</div>
              <div className="font-heading font-bold text-base">
                {formatHours(data.studies.studyMinutes)}
              </div>
              <div className="text-[0.5625rem] text-text-muted">{data.studies.minutesDelta}</div>
            </div>
            <div>
              <div className="text-[0.5625rem] uppercase tracking-wider text-text-muted">{t('weeklyReview.sessions')}</div>
              <div className="font-heading font-bold text-base">{data.studies.sessionCount}</div>
            </div>
            <div>
              <div className="text-[0.5625rem] uppercase tracking-wider text-text-muted">{t('weeklyReview.gpa')}</div>
              <div className="font-heading font-bold text-base">
                {data.studies.gpa != null ? data.studies.gpa.toFixed(2) : '—'}
              </div>
            </div>
          </div>
          {/* v1.22 (NCC#278): hours per course. */}
          {extras.studyByCourse.length > 0 && (
            <div className="mt-2 space-y-0.5">
              {extras.studyByCourse.slice(0, 4).map((c) => (
                <div key={c.courseId} className="flex justify-between items-center gap-2 text-[0.625rem] text-text-muted">
                  <span className="truncate">{c.name}</span>
                  <span className="flex items-center gap-2">
                    <span className="font-mono">{formatHours(c.minutes)}</span>
                    {/* v1.22 (limecore#131): that course in StudyDesk. */}
                    <SuiteAppLink app="studydesk" route={`course/${c.courseId}`} />
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Fitness — read-only summary (the dedicated screen was removed in
            the v1.3 scope reduction; this stays as a signal recap). */}
        <div className="card">
          <div className="flex items-center justify-between mb-2">
            <span className="font-heading font-semibold text-sm inline-flex items-center gap-1.5"><Glyph name="fitness" size={13} className="text-text-muted" />{t('weeklyReview.fitness')}</span>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div>
              <div className="text-[0.5625rem] uppercase tracking-wider text-text-muted">{t('weeklyReview.workouts')}</div>
              <div className="font-heading font-bold text-base">{data.fitness.workoutCount}</div>
              <div className="text-[0.5625rem] text-text-muted">{data.fitness.workoutsDelta}</div>
            </div>
            <div>
              <div className="text-[0.5625rem] uppercase tracking-wider text-text-muted">{t('weeklyReview.sets')}</div>
              <div className="font-heading font-bold text-base">{data.fitness.totalSets}</div>
            </div>
            <div>
              <div className="text-[0.5625rem] uppercase tracking-wider text-text-muted">{t('weeklyReview.volume')}</div>
              <div className="font-heading font-bold text-base">
                {data.fitness.totalVolumeKg > 0
                  ? `${Math.round(data.fitness.totalVolumeKg).toLocaleString(formatLocale())} kg`
                  : '—'}
              </div>
            </div>
          </div>
          {data.fitness.topExercise && (
            <div className="text-[0.625rem] text-text-muted mt-2">
              {t('weeklyReview.mostTrained', { name: data.fitness.topExercise, sets: data.fitness.topExerciseSets })}
            </div>
          )}
          {/* v1.22 (limecore#131): progress in LimeLog. */}
          <div className="mt-2">
            <SuiteAppLink app="limelog" route="progress" />
          </div>
          {/* v1.22 (NCC#278): heaviest sets that beat every earlier one. */}
          {extras.newBests.length > 0 && (
            <div className="text-[0.625rem] text-success mt-1">
              {t('weeklyReview.newBests')}:{' '}
              {extras.newBests.map((b) => `${b.exercise} ${b.weightKg.toLocaleString(formatLocale())} kg`).join(' · ')}
            </div>
          )}
        </div>

        {/* v1.22 (NCC#278): habits kept this week. */}
        {extras.habitsKept && (
          <button
            onClick={() => navigate('/habits')}
            className="card text-start w-full active:bg-surface2/40 flex items-center justify-between"
          >
            <span className="font-heading font-semibold text-sm">{t('weeklyReview.habitsKept')}</span>
            <span className="font-heading font-bold text-base">
              {t('weeklyReview.habitsKeptValue', { hit: extras.habitsKept.hit, due: extras.habitsKept.due })}
            </span>
          </button>
        )}

        {/* Tasks */}
        <button
          onClick={() => navigate('/tasks')}
          className="card text-start w-full active:bg-surface2/40"
        >
          <div className="flex items-center justify-between mb-2">
            <span className="font-heading font-semibold text-sm inline-flex items-center gap-1.5"><Glyph name="tasks" size={13} className="text-text-muted" />{t('weeklyReview.tasks')}</span>
            <span className="text-[0.5625rem] uppercase tracking-wider text-primary border border-primary/40 rounded-sm px-1.5 py-0.5">
              {t('weeklyReview.open')}
            </span>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div>
              <div className="text-[0.5625rem] uppercase tracking-wider text-text-muted">{t('weeklyReview.completed')}</div>
              <div className="font-heading font-bold text-base">{data.tasks.completed}</div>
              <div className="text-[0.5625rem] text-text-muted">{data.tasks.completedDelta}</div>
            </div>
            <div>
              <div className="text-[0.5625rem] uppercase tracking-wider text-text-muted">{t('weeklyReview.new')}</div>
              <div className="font-heading font-bold text-base">{data.tasks.created}</div>
            </div>
            <div>
              <div className="text-[0.5625rem] uppercase tracking-wider text-text-muted">{t('weeklyReview.openCount')}</div>
              <div className="font-heading font-bold text-base">{data.tasks.stillOpen}</div>
            </div>
          </div>
          {data.tasks.overdue > 0 && (
            <div className="text-[0.625rem] text-danger mt-2">
              <Glyph name="warning" size={12} className="inline-block align-[-1px] me-1" />{t('weeklyReview.overdue', { n: data.tasks.overdue })}
            </div>
          )}
        </button>

        </>)}

        {/* v1.22 (NCC#278): what's coming, for the current week only. */}
        {weekOffset === 0 && (
          <div className="card">
            <div className="font-heading font-semibold text-sm mb-2">{t('weeklyReview.nextWeek')}</div>
            <div className="text-[0.5625rem] uppercase tracking-wider text-text-muted mb-1">{t('weeklyReview.billsDue')}</div>
            {extras.billsNextWeek.length === 0 ? (
              <div className="text-xs text-text-muted">{t('weeklyReview.nothingDue')}</div>
            ) : (
              <div className="space-y-0.5">
                {extras.billsNextWeek.slice(0, 8).map((b) => (
                  <div key={`${b.ruleId}:${b.date}`} className="flex justify-between gap-2 text-xs">
                    <span className="truncate">{formatShortDate(b.date)} · {b.description}</span>
                    <span className="font-mono text-text-muted whitespace-nowrap">−{fmtMoney(b.amount)}</span>
                  </div>
                ))}
              </div>
            )}
            {/* v1.22 (NCC#278): StudyDesk's open exams and assignments, signed in only. */}
            {userId && (
              <>
                <div className="text-[0.5625rem] uppercase tracking-wider text-text-muted mt-3 mb-1">{t('weeklyReview.deadlines')}</div>
                {deadlines.length === 0 ? (
                  <div className="text-xs text-text-muted">{t('weeklyReview.noDeadlines')}</div>
                ) : (
                  <div className="space-y-0.5">
                    {deadlines.slice(0, 8).map((d) => {
                      const course = courses.find((c) => c.id === d.subjectId)?.name;
                      return (
                        <div key={`${d.kind}:${d.id}`} className="flex justify-between gap-2 text-xs">
                          <span className="truncate">
                            {d.kind === 'exam' && <span className="text-warning me-1">{t('weeklyReview.exam')}</span>}
                            {course ? `${course} · ` : ''}
                            {d.title}
                          </span>
                          <span className="text-text-muted whitespace-nowrap">{dueLabel(d.dueDate)}</span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        <button
          onClick={() => navigate('/review/year')}
          className="card w-full text-start active:bg-surface2/40"
        >
          <div className="flex items-center justify-between">
            <div>
              <div className="font-heading font-semibold text-sm inline-flex items-center gap-1.5"><Glyph name="calendar" size={13} className="text-text-muted" />{t('weeklyReview.yearInReview')}</div>
              <div className="text-[0.625rem] text-text-muted mt-0.5">
                {t('weeklyReview.yearInReviewSub')}
              </div>
            </div>
            <span className="chip-micro">
              {t('weeklyReview.open')}
            </span>
          </div>
        </button>

        <div className="card text-center text-[0.625rem] text-text-muted">
          {t('weeklyReview.footer')}
        </div>
      </div>
    </>
  );
}

