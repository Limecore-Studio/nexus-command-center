// ─── v1.2 Habit add/edit screen ─────────────────────────────────────────
//
// Single screen used both for adding new habits
// (no ?id query param) and editing existing ones (?id=<uuid>). The form is
// dynamic — quantified-only inputs collapse when type=binary; specific-day
// picker collapses when frequencyKind=daily.

import { useEffect, useState } from 'react';
import { useConfirm } from '../../components/ConfirmDialog';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router-dom';
import AppHeader from '../../components/AppHeader';
import { Pill } from '../../components/ui/Pill';
import { useHabitsStore } from '../../store/useHabitsStore';
import type { HabitType, HabitFrequencyKind } from '../../types/habits';
import { CATEGORICAL } from '../../lib/themeColors';

const TYPES: { key: HabitType; labelKey: string; hintKey: string }[] = [
  { key: 'binary', labelKey: 'addhabit.binary', hintKey: 'addhabit.binaryHint' },
  { key: 'quantified', labelKey: 'addhabit.quantified', hintKey: 'addhabit.quantifiedHint' },
];

const FREQS: { key: HabitFrequencyKind; labelKey: string }[] = [
  { key: 'daily', labelKey: 'addhabit.everyDay' },
  { key: 'specific_days', labelKey: 'addhabit.specificDays' },
];

const DAY_IDX = [0, 1, 2, 3, 4, 5, 6];
const DAY_SLUGS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

// The shared categorical ramp. Every swatch holds roughly the same chroma and
// value, so whichever the user picks the habit list stays coherent — and none
// of them collides with the semantic red/green a habit row uses to report
// streak state, which the old picker's red and green both did.
const COLORS = CATEGORICAL;

export default function AddHabit() {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const editId = params.get('id');

  const habits = useHabitsStore((s) => s.habits);
  const addHabit = useHabitsStore((s) => s.addHabit);
  const updateHabit = useHabitsStore((s) => s.updateHabit);
  const deleteHabit = useHabitsStore((s) => s.deleteHabit);

  const [title, setTitle] = useState('');
  const [type, setType] = useState<HabitType>('binary');
  const [targetAmount, setTargetAmount] = useState('');
  const [unit, setUnit] = useState('');
  const [frequencyKind, setFrequencyKind] = useState<HabitFrequencyKind>('daily');
  const [daysOfWeek, setDaysOfWeek] = useState<number[]>([1, 2, 3, 4, 5]); // weekdays default
  const [reminderTime, setReminderTime] = useState('');
  const [color, setColor] = useState<string>(COLORS[0]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!editId) return;
    const h = habits.find((x) => x.id === editId);
    if (!h) return;
    // HYG-4: Seeding an editable form from the record being edited — see
    // AddTransaction for why this cannot be derived.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTitle(h.title);
    setType(h.type);
    setTargetAmount(h.targetAmount != null ? String(h.targetAmount) : '');
    setUnit(h.unit ?? '');
    setFrequencyKind(h.frequencyKind);
    setDaysOfWeek(h.daysOfWeek ?? [1, 2, 3, 4, 5]);
    setReminderTime(h.reminderTime ?? '');
    setColor(h.color ?? COLORS[0]);
  }, [editId, habits]);

  function toggleDay(d: number) {
    setDaysOfWeek((current) =>
      current.includes(d)
        ? current.filter((x) => x !== d)
        : [...current, d].sort((a, b) => a - b),
    );
  }

  const submit = async () => {
    if (!title.trim()) return;
    if (type === 'quantified' && !targetAmount) return;
    if (frequencyKind === 'specific_days' && daysOfWeek.length === 0) return;
    setSaving(true);
    const target = type === 'quantified' ? parseFloat(targetAmount) : undefined;
    const payload = {
      title: title.trim(),
      type,
      targetAmount: target,
      unit: type === 'quantified' && unit.trim() ? unit.trim() : undefined,
      frequencyKind,
      daysOfWeek: frequencyKind === 'specific_days' ? daysOfWeek : undefined,
      reminderTime: reminderTime || undefined,
      color: color || undefined,
    };
    if (editId) {
      await updateHabit(editId, payload);
    } else {
      await addHabit(payload);
    }
    setSaving(false);
    navigate('/habits');
  };

  const onDelete = async () => {
    if (!editId) return;
    if (!(await confirm({ message: t('addhabit.deleteConfirm', { title }) }))) return;
    await deleteHabit(editId);
    navigate('/habits');
  };

  const validationMsg = !title.trim()
    ? t('addhabit.valName')
    : type === 'quantified' && !targetAmount
      ? t('addhabit.valTarget')
      : frequencyKind === 'specific_days' && daysOfWeek.length === 0
        ? t('addhabit.valDays')
        : null;

  return (
    <>
      <AppHeader
        title={editId ? t('addhabit.editTitle') : t('addhabit.newTitle')}
        back="/habits"
        backLabel={t('domains.habits')}
        showAvatar={false}
      />
      <div className="space-y-4">
        {/* Type */}
        <div>
          <div className="sec mb-2">{t('addhabit.type')}</div>
          <div className="flex gap-2">
            {TYPES.map((opt) => (
              <Pill
                key={opt.key}
                on={type === opt.key}
                onClick={() => setType(opt.key)}
              >
                {t(opt.labelKey)}
              </Pill>
            ))}
          </div>
          <div className="text-[0.625rem] text-text-muted mt-1.5">
            {t(TYPES.find((opt) => opt.key === type)?.hintKey ?? 'addhabit.binaryHint')}
          </div>
        </div>

        {/* Title — v1.2 UI/UX review #6: wrapped in <label> so the visual
            mini-header is programmatically tied to its input. Screen readers
            now announce "Title, edit text" instead of just "edit text". */}
        <label className="block">
          <div className="sec mb-2">{t('addhabit.title')}</div>
          <input
            className="input"
            placeholder={type === 'binary' ? t('addhabit.phBinary') : t('addhabit.phQuant')}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            // v1.18.1 (NCC#156): the server's habits_title_check allows 80
            // characters; a longer title was refused there and the habit,
            // with its completions, never synced.
            maxLength={80}
            autoFocus
          />
        </label>

        {/* Quantified-only — target + unit.  Two real <label>s side-by-side
            so the amount + unit each announce their own header in screen
            readers. The glass-card wrapper is purely visual. */}
        {type === 'quantified' && (
          <div className="panel p-3 space-y-2 animate-fade-in-up">
            <div className="sec">{t('addhabit.dailyTarget')}</div>
            <div className="flex gap-2">
              <label className="flex-1 block">
                <span className="sr-only">{t('addhabit.targetAmountAria')}</span>
                <input
                  className="input w-full"
                  inputMode="decimal"
                  placeholder={t('addhabit.amount')}
                  value={targetAmount}
                  onChange={(e) => setTargetAmount(e.target.value)}
                />
              </label>
              <label className="flex-1 block">
                <span className="sr-only">{t('addhabit.unitAria')}</span>
                <input
                  className="input w-full"
                  placeholder={t('addhabit.unitPlaceholder')}
                  value={unit}
                  onChange={(e) => setUnit(e.target.value)}
                />
              </label>
            </div>
            <div className="text-[0.625rem] text-text-muted">
              {t('addhabit.dayCountsWhen')}
            </div>
          </div>
        )}

        {/* Frequency */}
        <div>
          <div className="sec mb-2">{t('addhabit.frequency')}</div>
          <div className="flex gap-2">
            {FREQS.map((f) => (
              <Pill
                key={f.key}
                on={frequencyKind === f.key}
                onClick={() => setFrequencyKind(f.key)}
              >
                {t(f.labelKey)}
              </Pill>
            ))}
          </div>
        </div>

        {/* Specific-day picker */}
        {frequencyKind === 'specific_days' && (
          <div className="panel p-3 space-y-2 animate-fade-in-up">
            <div className="sec">{t('addhabit.daysOfWeek')}</div>
            {/* v1.2 UI/UX review #5 — default-size Pill keeps the touch
                target ≥40px (the .pill base height). size="sm" rendered
                under-spec for WCAG 2.5.5. The row stays a single line on
                360px+ devices because seven 3-letter labels fit comfortably
                in the .pill horizontal padding. */}
            <div className="flex gap-1.5 flex-wrap">
              {DAY_IDX.map((idx) => (
                <Pill
                  key={idx}
                  on={daysOfWeek.includes(idx)}
                  onClick={() => toggleDay(idx)}
                >
                  {t(`days.short.${DAY_SLUGS[idx]}`)}
                </Pill>
              ))}
            </div>
            <div className="text-[0.625rem] text-text-muted">
              {t('addhabit.streakGrace')}
            </div>
          </div>
        )}

        {/* Reminder — wrapped in <label> for the same a11y reason as Title. */}
        <label className="block">
          <div className="sec mb-2">{t('addhabit.reminderOptional')}</div>
          <input
            type="time"
            className="input"
            value={reminderTime}
            onChange={(e) => setReminderTime(e.target.value)}
          />
          <div className="text-[0.625rem] text-text-muted mt-1">
            {reminderTime
              ? t('addhabit.reminderAt', { time: reminderTime })
              : t('addhabit.reminderBlank')}
          </div>
        </label>

        {/* Color swatches */}
        <div>
          <div className="sec mb-2">{t('addhabit.color')}</div>
          <div className="flex gap-2 flex-wrap">
            {COLORS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setColor(c)}
                aria-label={t('addhabit.pickColor', { color: c })}
                // v1.2 UI/UX review #4 — w-11 h-11 meets WCAG 2.5.5 (44×44).
                // The selected ring stays as a scale-110 outline so the
                // emphasized state remains visually distinct from idle.
                className={`w-11 h-11 rounded-full press-spring border-2 transition-transform ${
                  color === c
                    ? 'border-text scale-110'
                    : 'border-border scale-100'
                }`}
                style={{ background: c }}
              />
            ))}
          </div>
        </div>

        {validationMsg && (
          <div className="panel-2 p-2 text-[0.6875rem] text-warning text-center">
            {validationMsg}
          </div>
        )}

        <button
          className="btn w-full"
          onClick={submit}
          disabled={saving || validationMsg != null}
        >
          {saving ? t('addhabit.saving') : editId ? t('addhabit.saveChanges') : t('addhabit.addHabit')}
        </button>
        {editId && (
          <button
            className="btn-ghost w-full text-danger border-danger/40"
            onClick={onDelete}
          >
            {t('addhabit.deleteHabit')}
          </button>
        )}
        <div className="text-[0.625rem] text-text-muted text-center">
          {t('habits.syncedAcross')}
        </div>
      </div>
    </>
  );
}
