import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import AppHeader from '../components/AppHeader';
import SyncStatusChip from '../components/SyncStatusChip';
import StatCard from '../components/StatCard';
import RoutingStrip from '../components/RoutingStrip';
import RackBudgetMeter from '../components/RackBudgetMeter';
import { RackMeterBank, RackChannels } from '../components/RackDashboard';
import { useActiveTheme } from '../lib/theme';
import ModuleSummaryCard from '../components/ModuleSummaryCard';
import HabitsDashboardStrip from '../components/HabitsDashboardStrip';
import WorkRatingCard from '../components/WorkRatingCard';
import CrossDomainCard from '../components/CrossDomainCard';
import ListRow from '../components/ListRow';
import ProgressBar from '../components/ProgressBar';
import { useFinanceStore } from '../store/useFinanceStore';
import { useStudiesStore } from '../store/useStudiesStore';
import { useFitnessStore } from '../store/useFitnessStore';
import { useTaskStore } from '../store/useTaskStore';
import { useBraindumpStore } from '../store/useBraindumpStore';
import { useGoalsStore } from '../store/useGoalsStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { computeGoalProgress } from '../lib/goals';
import { buildWeeklyReview } from '../lib/weeklyReview';
import { formatCurrency, isOverdue, isToday, localDateKey, parseDateLocal } from '../utils/formatters';

export default function Dashboard() {
  const { t } = useTranslation();
  const transactions = useFinanceStore((s) => s.transactions);
  const budgetCategories = useFinanceStore((s) => s.budgetCategories);
  const stockQuotes = useFinanceStore((s) => s.stockQuotes);

  const studies = useStudiesStore((s) => s.currentImport);
  const studyCourses = useStudiesStore((s) => s.courses);
  const previousGpa = useStudiesStore((s) => s.previousGpa);
  const gradeMode = useStudiesStore((s) => s.gradeMode);

  const sessions = useFitnessStore((s) => s.sessions);

  const tasks = useTaskStore((s) => s.tasks);
  const braindumpEntries = useBraindumpStore((s) => s.entries);
  // v1.15 Item 10 — Goals and Review cards.
  const goals = useGoalsStore((s) => s.goals);
  const holdings = useFinanceStore((s) => s.holdings);
  const manualAssets = useFinanceStore((s) => s.manualAssets);
  const cryptoPrices = useFinanceStore((s) => s.cryptoPrices);
  const fxRates = useFinanceStore((s) => s.fxRates);
  const studySessions = useStudiesStore((s) => s.studySessions);
  const baseCurrency = useSettingsStore((s) => s.baseCurrency);

  // Portfolio auto-refresh used to live here, but Dashboard mounts as a child
  // of AppShell — at first-mount the holdings store is still empty (AppShell's
  // load() is in flight), so the refresh saw `holdings: []` and bailed on the
  // empty-portfolio early-return. The net-worth widgets then sat on stale data
  // until the user navigated to /finance/portfolio, which has its own
  // mount-effect refresh that runs *after* holdings are populated.
  //
  // Auto-refresh now lives in AppShell, gated on `holdings.length` so it only
  // fires once holdings are actually loaded. Keep the selector above so the
  // Dashboard can still see live state — but no longer trigger a refresh here.

  const monthExpenses = useMemo(() => {
    // v1.18.1 (NCC#148): this month of THIS year. Comparing getMonth() alone
    // counted every past October against this October's budget.
    const month = localDateKey(new Date()).slice(0, 7);
    return transactions
      .filter((t) => t.type === 'expense' && localDateKey(parseDateLocal(t.date)).slice(0, 7) === month)
      .reduce((s, t) => s + t.amount, 0);
  }, [transactions]);

  const monthBudget = useMemo(
    () => budgetCategories.reduce((s, c) => s + c.monthlyLimit, 0),
    [budgetCategories]
  );
  const budgetPct = monthBudget > 0 ? Math.round((monthExpenses / monthBudget) * 100) : 0;
  // v1.15 (Item 13) — Rack adds two things the free theme never renders.
  const rack = useActiveTheme() === 'rack';
  // Rack's budget meter holds last month's spend as its peak.
  const lastMonthExpenses = useMemo(() => {
    const now = new Date();
    const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    return transactions
      .filter((t) => {
        if (t.type !== 'expense') return false;
        const d = parseDateLocal(t.date);
        return d.getFullYear() === prev.getFullYear() && d.getMonth() === prev.getMonth();
      })
      .reduce((s, t) => s + t.amount, 0);
  }, [transactions]);

  const tasksToday = tasks.filter((t) => !t.completed && t.dueDate && isToday(t.dueDate)).length;
  const tasksOverdue = tasks.filter((t) => !t.completed && t.dueDate && isOverdue(t.dueDate)).length;
  const tasksOpen = tasks.filter((t) => !t.completed);

  // HYG-4 — was memoised on [sessions], which pinned the seven-day window to
  // whenever the session list last changed: leave the app open across midnight
  // and the count kept measuring yesterday's week. Recomputing per render is a
  // filter over a short array and costs nothing measurable.
  //
  // The Date.now() call keeps this render impure and the rule is right about
  // that, but the impurity IS the feature — the window has to move with the
  // clock. Scoped rather than rewritten, since the only pure alternative is a
  // ticking clock in state for a number that changes once a day.
  // eslint-disable-next-line react-hooks/purity
  const weekAgo = Date.now() - 7 * 86400000;
  const workoutsThisWeek = sessions.filter((s) => parseDateLocal(s.date).getTime() > weekAgo).length;

  const gpaDelta = studies && previousGpa != null
    ? `${studies.calculatedGpa - previousGpa >= 0 ? '↑' : '↓'} ${Math.abs(studies.calculatedGpa - previousGpa).toFixed(2)} ${t('dash.pts')}`
    : studies ? t('dash.coursesCount', { count: studyCourses.length }) : t('dash.noImports');

  // Same inputs and the same computeGoalProgress the Goals screen uses, so a
  // percentage here can never disagree with the one a tap away.
  const activeGoals = useMemo(() => {
    const data = {
      transactions, holdings, manualAssets, stockQuotes, cryptoPrices, fxRates, baseCurrency,
      tasks, studySessions, workouts: sessions, currentGpa: studies?.calculatedGpa ?? null,
    };
    return goals
      .filter((g) => !g.completed && !g.deletedAt)
      .map((g) => ({ goal: g, pct: Math.max(0, Math.min(100, Math.round(computeGoalProgress(g, data).percent))) }));
  }, [goals, transactions, holdings, manualAssets, stockQuotes, cryptoPrices, fxRates, baseCurrency, tasks, studySessions, sessions, studies]);

  // This week so far, from the builder the Review screen itself uses.
  const week = useMemo(
    () => buildWeeklyReview({
      transactions, courses: studyCourses, sessions: studySessions, workouts: sessions, tasks,
      currentGpa: studies?.calculatedGpa ?? null, holdings,
    }),
    [transactions, studyCourses, studySessions, sessions, tasks, studies, holdings],
  );

  const gpaSuffix = gradeMode === 'ib' ? '/7' : gradeMode === 'custom' ? '/20' : '';
  const gpaDisplay = studies ? studies.calculatedGpa.toFixed(2) + gpaSuffix : '—';

  return (
    <>
      {/* v1.15 Item 10 — Goals and Review used to be two small chips here, and
          nowhere in persistent nav since the v1.3 scope reduction. They are
          full module cards below now, Braindump's treatment, rather than a
          fifth tab (no new bottom-nav tabs, owner call 2026-09-17). */}
      <AppHeader title="NEXUS HQ" />
      {/* v1.9 Item 14 — desktop arrangement, not a desktop redesign.
          Every card below is the same component with the same styling it has
          on the phone; only their arrangement changes. Below 1201px this is
          exactly the old single `space-y-3` stack, in the same order, because
          the three groups render in sequence and each carries its own
          `space-y-3`. At `desktop:` they become columns, so the width the
          shell now has gets used by *more cards side by side* rather than by
          stretching each card — which is what made the wide layout read as a
          blown-up phone screen. Three groups rather than a generic auto-flow
          so related things stay together: live signals, then the numbers,
          then the module entry points.
          `items-start` matters — without it the grid stretches every column to
          the tallest one and the short cards grow dead space inside. */}
      <div className="space-y-3 desktop:space-y-0 desk-grid">
        <div className="desk-stack">
          {/* Rack: the inputs row — the suite made visible. Dashboard only. */}
          {rack && <RoutingStrip />}
          <SyncStatusChip />

          {/* v1.2 — daily habits surface above the stat grid. The strip itself
              handles all empty/eligible/all-rest-day states; we render it
              unconditionally so the layout doesn't shift based on data. */}
          <HabitsDashboardStrip />

          {/* v1.5 — Work domain daily self-assessment. Self-gates: renders only
              when the active Life Profile includes Work, on weekday afternoons. */}
          <WorkRatingCard />

          {/* v1.2 — Cross-domain life-patterns rotator. Surfaces beneath the
              habits strip; handles its own baseline/quiet/insight states. */}
          <CrossDomainCard />
        </div>

        <div className="desk-stack">
          <div className="sec mb-2">{t('dash.overview')}</div>
          {/* Rack: the budget read off a meter face with the limit printed on
              it. Only when there is a budget to read. */}
          {rack && monthBudget > 0 && (
            <div className="mb-2">
              <RackBudgetMeter spent={monthExpenses} limit={monthBudget} lastMonthSpent={lastMonthExpenses} />
            </div>
          )}
          {/* Stays 2-up in its column at every width — these are four small
              stat tiles and a 1×4 row of them reads as a strip, not a group. */}
          {rack ? (
            <div className="space-y-2">
              <RackMeterBank
                gpa={studies ? studies.calculatedGpa : null}
                // v1.18.1 (NCC#165): an inferred 'custom' scale tops out at
                // 20 (see inferGradeMode), so a 14/20 does not pin a 0–4 meter.
                gpaMax={gradeMode === 'ib' ? 7 : gradeMode === 'custom' ? 20 : 4}
                gpaPrevious={studies ? previousGpa : null}
                gpaDisplay={gpaDisplay}
                workouts={workoutsThisWeek}
                workoutTarget={4}
                tasksDue={tasksToday + tasksOverdue}
                tasksOverdue={tasksOverdue}
              />
              <RackChannels tasks={tasks} />
            </div>
          ) : (
          <div className="grid grid-cols-2 gap-2">
            <StatCard
              value={formatCurrency(Math.max(0, monthBudget - monthExpenses))}
              label={t('dash.budgetLeft')}
              sub={monthBudget > 0 ? t('dash.pctUsed', { pct: budgetPct }) : t('dash.noBudgets')}
              tone={budgetPct > 90 ? 'danger' : budgetPct > 70 ? 'warning' : 'success'}
              highlight
            />
            <StatCard
              value={gpaDisplay}
              label={t('dash.gpa')}
              sub={gpaDelta}
              tone={studies ? 'success' : 'default'}
            />
            <StatCard
              value={`${workoutsThisWeek}×`}
              label={t('dash.workoutsWk')}
              sub={workoutsThisWeek >= 4 ? t('dash.onTarget') : t('dash.pushHarder')}
            />
            <StatCard
              value={tasksToday}
              label={t('dash.tasksToday')}
              sub={tasksOverdue > 0 ? t('dash.overdueWarn', { count: tasksOverdue }) : t('dash.allOnTrack')}
              tone={tasksOverdue > 0 ? 'danger' : 'default'}
            />
          </div>
          )}
        </div>

        <div className="desk-stack">
        <div className="sec mb-2">{t('dash.modules')}</div>
        <div className="grid grid-cols-1 gap-2">
          <ModuleSummaryCard title={t('domains.finance')} icon="finance" tag={monthBudget > 0 ? t('dash.tagLive') : t('dash.tagIdle')} to="/finance">
            {monthBudget > 0 ? (
              <ProgressBar
                label={t('dash.budgetUsed')}
                value={monthExpenses}
                max={monthBudget || 1}
                format={(v, m) => `${Math.round((v / m) * 100)}%`}
              />
            ) : (
              <Empty msg={t('dash.noBudgetsYet')} />
            )}
            {stockQuotes[0] ? (
              <ListRow
                label={`${stockQuotes[0].ticker} ${stockQuotes[0].cached ? t('dash.cached') : ''}`}
                value={`$${stockQuotes[0].quote.c.toFixed(2)}`}
              />
            ) : (
              <Empty msg={t('dash.noHoldings')} />
            )}
          </ModuleSummaryCard>

          <ModuleSummaryCard title={t('nav.tasks')} icon="tasks" tag={tasksOverdue > 0 ? t('dash.tagOverdue') : tasksOpen.length > 0 ? t('dash.tagOpen') : t('dash.tagClear')} to="/tasks">
            {tasksOpen.length > 0 ? (
              tasksOpen.slice(0, 2).map((task) => (
                <ListRow
                  key={task.id}
                  label={task.title}
                  tag={task.dueDate && isOverdue(task.dueDate) ? { text: t('dash.late'), tone: 'red' } :
                       task.dueDate && isToday(task.dueDate) ? { text: t('dash.today'), tone: 'amber' } : undefined}
                />
              ))
            ) : (
              <>
                <Empty msg={t('dash.allClear')} />
                <Empty msg={t('dash.tapToAdd')} />
              </>
            )}
            {tasksOpen.length === 1 && <Empty msg=" " />}
          </ModuleSummaryCard>

          {/* v1.12 Item 10 - Braindump. Surfaced on the dashboard rather than
              buried behind a nav entry: the friction this feature exists to
              kill is "I had an idea and getting it recorded cost too much", so
              the entry point has to be on the first screen. */}
          <ModuleSummaryCard
            title={t('domains.braindump')}
            icon="sparkle"
            tag={braindumpEntries.length > 0 ? t('dash.tagOpen') : t('dash.tagClear')}
            to="/braindump"
          >
            {braindumpEntries.length > 0 ? (
              braindumpEntries.slice(0, 2).map((e) => (
                <ListRow key={e.id} label={firstLineOf(e.content)} />
              ))
            ) : (
              <>
                <Empty msg={t('braindump.emptyTitle')} />
                <Empty msg={t('dash.tapToAdd')} />
              </>
            )}
            {braindumpEntries.length === 1 && <Empty msg=" " />}
          </ModuleSummaryCard>

          <ModuleSummaryCard
            title={t('dash.goals')}
            icon="goals"
            tag={activeGoals.length > 0 ? t('dash.tagOpen') : t('dash.tagClear')}
            to="/goals"
          >
            {activeGoals.length > 0 ? (
              activeGoals.slice(0, 2).map(({ goal, pct }) => (
                <ListRow key={goal.id} label={goal.title} value={`${pct}%`} />
              ))
            ) : (
              <>
                <Empty msg={t('goals.noGoalsTitle')} />
                <Empty msg=" " />
              </>
            )}
            {activeGoals.length === 1 && <Empty msg=" " />}
          </ModuleSummaryCard>

          <ModuleSummaryCard title={t('dash.review')} icon="calendar" to="/review">
            <ListRow label={t('weeklyReview.tasks')} value={String(week.tasks.completed)} />
            <ListRow label={t('weeklyReview.workouts')} value={String(week.fitness.workoutCount)} />
          </ModuleSummaryCard>
        </div>
        </div>
      </div>
    </>
  );
}

/** First non-empty line of a braindump entry, capped for a one-line row. */
function firstLineOf(content: string): string {
  const line = (content || '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) || '';
  return line.length > 60 ? `${line.slice(0, 57)}…` : line;
}

function Empty({ msg }: { msg: string }) {
  return <div className="text-[0.6875rem] text-text-muted/70 italic">{msg}</div>;
}
