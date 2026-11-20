// ─── v1.5 WorkRatingCard ─────────────────────────────────────────────────
//
// Home-tab daily self-assessment for the NCC-native Work domain. "How was
// work today?" on a 1–5 scale + an optional short note. Feeds the Work score
// that the Professional / Custom Life Profiles weight into the Life Score.
//
// Visibility rules (matches the v1.5 plan):
//   - only when the active Life Profile includes Work (weight > 0)
//   - only from noon onward — no point rating the day at 7am
//   - hidden on weekends (default off; work-life ratings are a weekday ritual)
//
// Cyber Slate Glass: panel card, cyan-lit selected circle with spring press,
// inline note that collapses when empty.

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { weekdayNames } from '../utils/formatters';
import { useWorkQualityStore, todayKey } from '../store/useWorkQualityStore';
import { useLifeProfileStore } from '../store/useLifeProfileStore';

const NOTE_MAX = 120;


export default function WorkRatingCard() {
  const { t } = useTranslation();
  const workWeight = useLifeProfileStore((s) => s.profile.domains.work);
  const logs = useWorkQualityStore((s) => s.logs);
  const loaded = useWorkQualityStore((s) => s.loaded);
  const load = useWorkQualityStore((s) => s.load);
  const setRating = useWorkQualityStore((s) => s.setRating);
  const setNote = useWorkQualityStore((s) => s.setNote);

  const today = todayKey();
  const todayLog = logs.find((l) => l.date === today);

  const [noteOpen, setNoteOpen] = useState(false);
  const [noteDraft, setNoteDraft] = useState('');
  const noteHydratedFor = useRef<string | null>(null);

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  // Keep the local note draft in sync with the stored note for today, but only
  // re-seed when the underlying note identity changes (not on every keystroke).
  useEffect(() => {
    if (noteHydratedFor.current !== today) {
      setNoteDraft(todayLog?.note ?? '');
      noteHydratedFor.current = today;
      // HYG-4: Ref-guarded on `today`, so this re-seeds once per day identity rather
      // than per render. Deriving would discard the user's in-progress draft
      // every time the stored note changed underneath them.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (todayLog?.note) setNoteOpen(true);
    }
  }, [today, todayLog?.note]);

  const now = new Date();
  const hour = now.getHours();
  const dow = now.getDay();

  // Gate: only for Work-enabled profiles, weekday afternoons.
  if (!workWeight || workWeight <= 0) return null;
  if (dow === 0 || dow === 6) return null;
  if (hour < 12) return null;

  const rating = todayLog?.rating ?? 0;

  const onPickRating = (n: number) => {
    // Preserve the existing note (pass undefined to keep it).
    void setRating(n, undefined, today);
  };

  const onNoteBlur = () => {
    void setNote(noteDraft, today);
    if (!noteDraft.trim()) setNoteOpen(false);
  };

  return (
    <div className="panel p-4">
      <div className="flex items-center justify-between mb-3">
        <span className="text-sm font-medium">
          {rating > 0 ? t('ql.workToday') : t('ql.workQuestion')}
        </span>
        <span className="text-[0.625rem] uppercase tracking-wider text-text-muted">
          {weekdayNames('short')[dow]}
        </span>
      </div>

      <div className="flex gap-2.5" role="group" aria-label={t('ql.rateGroup')}>
        {[1, 2, 3, 4, 5].map((n) => {
          const on = rating === n;
          return (
            <button
              key={n}
              onClick={() => onPickRating(n)}
              aria-pressed={on}
              aria-label={t('ql.ratingOf', { n })}
              className={`press-spring flex-1 h-11 rounded-md border text-lg font-heading font-semibold transition-colors ${
                on
                  ? 'border-primary/60 bg-primary/10 text-primary'
                  : 'border-border text-text-muted'
              }`}
            >
              {n}
            </button>
          );
        })}
      </div>

      {noteOpen ? (
        <textarea
          className="input mt-3 resize-none h-16 text-sm"
          placeholder={t('ql.notePh')}
          maxLength={NOTE_MAX}
          value={noteDraft}
          onChange={(e) => setNoteDraft(e.target.value)}
          onBlur={onNoteBlur}
          autoFocus
        />
      ) : (
        <button
          onClick={() => setNoteOpen(true)}
          className="mt-3 text-xs text-text-muted/80 active:text-text"
        >
          {todayLog?.note ? `“${todayLog.note}”` : t('ql.addNote')}
        </button>
      )}
    </div>
  );
}
