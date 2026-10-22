// Goals screen. Lists active + completed goals, each with live progress
// computed from every relevant module's current state. Tap an active goal
// to expand actions (mark complete / edit / delete). Tap + Goal to add.
//
// Progress is derived live (see `lib/goals.ts`) — no cached "currentValue"
// on the row, so editing a workout / undoing a task / refreshing the
// portfolio immediately moves every relevant bar.

import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import AppHeader from '../components/AppHeader';
import GoalPaceBar from '../components/GoalPaceBar';
import { pacingFor } from '../lib/goalPacing';
import RowActions from '../components/RowActions';
import { useGoalsStore } from '../store/useGoalsStore';
import { useFinanceStore } from '../store/useFinanceStore';
import { useStudiesStore } from '../store/useStudiesStore';
import { useFitnessStore } from '../store/useFitnessStore';
import { useTaskStore } from '../store/useTaskStore';
import { useSettingsStore } from '../store/useSettingsStore';
import {
  computeGoalProgress,
  formatGoalValue,
  defaultTargetValue,
  type DataSources,
} from '../lib/goals';
import {
  GOAL_TYPES,
  GOAL_TYPE_LABELS,
  isCumulativeGoal,
  type Goal,
  type GoalType,
} from '../types/goals';
import Glyph from '../components/Glyph';
// v1.18.1 (NCC#144): typed amounts accept a decimal comma.
import { numberInput } from '@/lib/numberInput';
import { localDateKey } from '@/utils/formatters';

export default function Goals() {
  const { t } = useTranslation();
  const goals = useGoalsStore((s) => s.goals);
  const addGoal = useGoalsStore((s) => s.addGoal);
  const updateGoal = useGoalsStore((s) => s.updateGoal);
  const markCompleted = useGoalsStore((s) => s.markCompleted);
  const deleteGoal = useGoalsStore((s) => s.deleteGoal);

  // Pull live data from every relevant module so progress refreshes
  // automatically when any underlying source changes.
  const holdings = useFinanceStore((s) => s.holdings);
  const stockQuotes = useFinanceStore((s) => s.stockQuotes);
  const cryptoPrices = useFinanceStore((s) => s.cryptoPrices);
  const fxRates = useFinanceStore((s) => s.fxRates);
  const manualAssets = useFinanceStore((s) => s.manualAssets);
  const transactions = useFinanceStore((s) => s.transactions);
  const tasks = useTaskStore((s) => s.tasks);
  const studySessions = useStudiesStore((s) => s.studySessions);
  const currentImport = useStudiesStore((s) => s.currentImport);
  const workouts = useFitnessStore((s) => s.sessions);
  const baseCurrency = useSettingsStore((s) => s.baseCurrency);

  const dataSources: DataSources = useMemo(
    () => ({
      transactions,
      holdings,
      manualAssets,
      stockQuotes,
      cryptoPrices,
      fxRates,
      baseCurrency,
      tasks,
      studySessions,
      workouts,
      currentGpa: currentImport?.calculatedGpa ?? null,
    }),
    [
      transactions,
      holdings,
      manualAssets,
      stockQuotes,
      cryptoPrices,
      fxRates,
      baseCurrency,
      tasks,
      studySessions,
      workouts,
      currentImport,
    ],
  );

  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Goal | null>(null);

  const active = goals.filter((g) => !g.completed);
  const completed = goals.filter((g) => g.completed);

  const editingNow = adding || editing != null;

  return (
    <>
      <AppHeader
        title={t('goals.title')}
        back="/"
        backLabel={t('nav.home')}
        showAvatar={false}
        action={
          !editingNow && (
            <button
              onClick={() => setAdding(true)}
              className="chip press-spring"
            >
              + {t('goals.new')}
            </button>
          )
        }
      />
      <div className="space-y-3">
        {editingNow && (
          <GoalForm
            initial={editing}
            baseCurrency={baseCurrency}
            onCancel={() => {
              setAdding(false);
              setEditing(null);
            }}
            onSave={async (g) => {
              if (editing) {
                await updateGoal(editing.id, g);
              } else {
                await addGoal(g);
              }
              setAdding(false);
              setEditing(null);
            }}
          />
        )}

        {goals.length === 0 && !editingNow && (
          <div className="card text-center text-xs text-text-muted py-6">
            {t('goals.noGoalsTitle')}
            <div className="text-[0.625rem] mt-2">
              {t('goals.noGoalsBody')}
            </div>
          </div>
        )}

        {active.length > 0 && !editingNow && (
          <div className="card space-y-3">
            <div className="text-[0.625rem] uppercase tracking-wider text-text-muted">{t('goals.active')}</div>
            {active.map((g) => (
              <GoalRow
                key={g.id}
                goal={g}
                data={dataSources}
                baseCurrency={baseCurrency}
                onEdit={() => setEditing(g)}
                onComplete={() => markCompleted(g.id, true)}
                onDelete={() => deleteGoal(g.id)}
              />
            ))}
          </div>
        )}

        {completed.length > 0 && !editingNow && (
          <div className="card space-y-3 opacity-80">
            <div className="text-[0.625rem] uppercase tracking-wider text-success">{t('goals.completed')}</div>
            {completed.map((g) => (
              <GoalRow
                key={g.id}
                goal={g}
                data={dataSources}
                baseCurrency={baseCurrency}
                onEdit={() => setEditing(g)}
                onComplete={() => markCompleted(g.id, false)}
                onDelete={() => deleteGoal(g.id)}
              />
            ))}
          </div>
        )}
      </div>
    </>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Goal row
// ───────────────────────────────────────────────────────────────────────────

function GoalRow({
  goal,
  data,
  baseCurrency,
  onEdit,
  onComplete,
  onDelete,
}: {
  goal: Goal;
  data: DataSources;
  baseCurrency: string;
  onEdit: () => void;
  onComplete: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const progress = useMemo(() => computeGoalProgress(goal, data), [goal, data]);
  // Fallback guards against a stored goal whose type was retired (e.g. the
  // v1.4 `reading_count` removal) — the v17 migration deletes such rows, but
  // this keeps the row from crashing if one is mid-flight from a cloud pull.
  const rawMeta = GOAL_TYPE_LABELS[goal.goalType] ?? { label: goal.goalType, unit: '', icon: 'goals' };
  const meta = { ...rawMeta, label: t(`goalTypes.${goal.goalType}`, { defaultValue: rawMeta.label }) };
  // v1.14 — pacing against an evenly distributed reference trajectory. The
  // old `paceLabel` is gone from this screen: it returned English to all ten
  // locales, and "behind by 1.5" is a verdict with no action in it.
  const pacing = pacingFor(progress.currentValue, goal);

  // The sentence under the bar, and the bar's own accessible name.
  //
  // Behind is the only one that changes shape: it names the work that CLOSES
  // the gap rather than the size of the gap, because a goal is reached at an
  // uneven pace and a quiet week is not a failure. `remainingPerWeek` is null
  // on the final day — there is no week left to spread anything over — and
  // that case falls back to the plain remainder rather than printing a rate
  // for a week that does not exist.
  const paceText = (() => {
    if (pacing.status === 'done') return t('goals.paceDone');
    if (pacing.status === 'unknown') return null;
    if (pacing.status === 'ahead') return t('goals.paceAhead');
    if (pacing.status === 'on') return t('goals.paceOn');
    if (pacing.remainingPerWeek != null) {
      return t('goals.paceBehind', {
        amount: formatGoalValue(goal, pacing.remainingPerWeek, baseCurrency),
      });
    }
    return t('goals.paceBehindNoTime', {
      amount: formatGoalValue(goal, pacing.remaining, baseCurrency),
    });
  })();

  return (
    <div className="py-2 border-b border-border/40 last:border-0">
      <div className="flex items-start gap-2">
        <Glyph name={meta.icon} size={15} className="text-text-muted mt-1" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <div className="font-heading font-semibold text-sm truncate">{goal.title}</div>
            <RowActions
              onEdit={onEdit}
              onDelete={onDelete}
              confirmMsg={t('goals.deleteConfirm', { title: goal.title })}
            />
          </div>
          <div className="flex items-center gap-2 mt-1">
            <GoalPaceBar
              progress={pacing.status === 'unknown' ? progress.percent / 100 : pacing.progress}
              elapsed={pacing.elapsed}
              status={pacing.status}
              label={paceText ?? t('goals.noDeadline')}
            />
            <span className="text-[0.625rem] text-text-muted whitespace-nowrap">
              {Math.round(progress.percent)}%
            </span>
          </div>
          <div className="flex items-center justify-between text-[0.625rem] text-text-muted mt-1">
            <span>
              {formatGoalValue(goal, progress.currentValue, baseCurrency)}
              {' / '}
              {formatGoalValue(goal, goal.targetValue, baseCurrency)}
            </span>
            <span>
              {progress.daysRemaining != null
                ? `${t('goals.daysLeft', { days: progress.daysRemaining })}${paceText ? ` · ${paceText}` : ''}`
                : t('goals.noDeadline')}
            </span>
          </div>
          {progress.reached && !goal.completed && (
            <button
              onClick={onComplete}
              className="text-[0.625rem] mt-2 px-2 py-1 rounded-sm border border-success/40 bg-success/5 text-success active:bg-success/10"
            >
              {t('goals.markComplete')}
            </button>
          )}
          {goal.completed && (
            <button
              onClick={onComplete}
              className="text-[0.625rem] mt-2 px-2 py-1 rounded-sm border border-border text-text-muted active:text-text"
            >
              {t('goals.reopen')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Goal create/edit form
// ───────────────────────────────────────────────────────────────────────────

function GoalForm({
  initial,
  baseCurrency,
  onCancel,
  onSave,
}: {
  initial: Goal | null;
  baseCurrency: string;
  onCancel: () => void;
  onSave: (g: Omit<Goal, 'id' | 'createdAt' | 'updatedAt' | 'syncStatus' | 'completed' | 'completedAt' | 'deletedAt'>) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [title, setTitle] = useState(initial?.title ?? '');
  const [goalType, setGoalType] = useState<GoalType>(initial?.goalType ?? 'workout_count');
  const [targetValue, setTargetValue] = useState<string>(
    initial ? String(initial.targetValue) : String(defaultTargetValue('workout_count')),
  );
  const [targetDate, setTargetDate] = useState<string>(initial?.targetDate ?? '');
  const [startDate, setStartDate] = useState<string>(
    initial?.startDate ?? localDateKey(new Date()),
  );
  const [exerciseName, setExerciseName] = useState<string>(initial?.exerciseName ?? '');

  const onPickType = (gt: GoalType) => {
    setGoalType(gt);
    // Auto-suggest a sensible target when the user picks a new type — only
    // if they haven't typed something custom yet.
    if (!initial || targetValue === String(defaultTargetValue(initial.goalType))) {
      setTargetValue(String(defaultTargetValue(gt)));
    }
  };

  const meta = GOAL_TYPE_LABELS[goalType];
  const needsExercise = goalType === 'lift_pr';
  const isCumulative = isCumulativeGoal(goalType);

  const save = async () => {
    const targetNum = numberInput(targetValue);
    if (!title.trim() || !Number.isFinite(targetNum) || targetNum <= 0) return;
    if (needsExercise && !exerciseName.trim()) return;
    await onSave({
      title: title.trim(),
      goalType,
      targetValue: targetNum,
      targetDate: targetDate || undefined,
      startDate,
      exerciseName: needsExercise ? exerciseName.trim() : undefined,
      currency: goalType === 'net_worth' ? baseCurrency : undefined,
    });
  };

  return (
    <div className="card space-y-3">
      <div className="font-heading font-semibold text-sm">{initial ? t('goals.editGoal') : t('goals.newGoal')}</div>

      <input
        className="input"
        placeholder={t('goals.titlePlaceholder')}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        autoFocus
      />

      <div>
        <div className="text-[0.625rem] uppercase tracking-wider text-text-muted mb-1">{t('goals.type')}</div>
        <div className="grid grid-cols-3 gap-1.5">
          {GOAL_TYPES.map((gt) => {
            const m = GOAL_TYPE_LABELS[gt];
            return (
              <button
                key={gt}
                type="button"
                onClick={() => onPickType(gt)}
                className={`chip text-[0.6875rem] ${goalType === gt ? 'chip-on' : ''}`}
              >
                {m.icon} {t(`goalTypes.${gt}`, { defaultValue: m.label })}
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <div className="text-[0.625rem] uppercase tracking-wider text-text-muted mb-1">
          {t('goals.target')} {meta.unit ? `(${meta.unit})` : ''}
        </div>
        <input
          className="input"
          inputMode="decimal"
          placeholder={String(defaultTargetValue(goalType))}
          value={targetValue}
          onChange={(e) => setTargetValue(e.target.value)}
        />
      </div>

      {needsExercise && (
        <div>
          <div className="text-[0.625rem] uppercase tracking-wider text-text-muted mb-1">
            {t('goals.exerciseName')}
          </div>
          <input
            className="input"
            placeholder={t('goals.exercisePlaceholder')}
            value={exerciseName}
            onChange={(e) => setExerciseName(e.target.value)}
            autoCapitalize="words"
          />
          <div className="text-[0.625rem] text-text-muted mt-1">
            {t('goals.exerciseHint')}
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2">
        <div>
          <div className="text-[0.625rem] uppercase tracking-wider text-text-muted mb-1">
            {t('goals.startDate')}
          </div>
          <input
            type="date"
            className="input"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
          />
          {isCumulative && (
            <div className="text-[0.5625rem] text-text-muted mt-1">
              {t('goals.startHint')}
            </div>
          )}
        </div>
        <div>
          <div className="text-[0.625rem] uppercase tracking-wider text-text-muted mb-1">
            {t('goals.targetDate')} {goalType === 'lift_pr' || goalType === 'gpa' ? t('goals.optional') : ''}
          </div>
          <input
            type="date"
            className="input"
            value={targetDate}
            onChange={(e) => setTargetDate(e.target.value)}
          />
        </div>
      </div>

      <div className="flex gap-2">
        <button className="btn flex-1" onClick={save}>
          {initial ? t('common.save') : t('common.add')}
        </button>
        <button className="btn-ghost flex-1" onClick={onCancel}>
          {t('common.cancel')}
        </button>
      </div>
    </div>
  );
}
