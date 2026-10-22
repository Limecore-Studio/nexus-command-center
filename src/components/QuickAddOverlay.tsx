// v1.9 Item 14b #9 — keyboard-driven transaction entry.
//
// DESIGN — a command line, not a form.
// The existing Add Transaction screen is the right thing on a phone and the
// wrong thing for someone logging six expenses in a row on a keyboard: four
// taps of tab order per entry. This is one input, opened from anywhere with
// `n` or Ctrl/Cmd+K, saved with Enter, closed with Escape. The pointer is never
// required and never suggested.
//
// The live preview under the input is doing the real work. A terse syntax is
// only safe if the user can see what it parsed to BEFORE committing — so the
// amount, category, account and date all render as they are understood, and
// the save button states plainly what is missing when it is disabled.
//
// Desktop tier only. A phone has no keyboard shortcut to open this with, and
// the full Add Transaction screen is better with a thumb.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useFinanceStore } from '../store/useFinanceStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { formatMoney } from '../lib/currencies';
import { formatLocale, localDateKey } from '../utils/formatters';
import { isComplete, parseQuickEntry, rankMatches } from '../lib/quickEntry';
import Glyph from './Glyph';
import { compositionTracking, isComposing } from '../lib/imeSubmit';

interface Props {
  open: boolean;
  onClose: () => void;
}

export default function QuickAddOverlay({ open, onClose }: Props) {
  const { t } = useTranslation();
  const categories = useFinanceStore((s) => s.budgetCategories);
  const accounts = useFinanceStore((s) => s.manualAssets);
  const addTransaction = useFinanceStore((s) => s.addTransaction);
  const baseCurrency = useSettingsStore((s) => s.baseCurrency);

  const inputRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');
  const [caret, setCaret] = useState(0);
  const [highlight, setHighlight] = useState(0);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);

  const today = useMemo(() => localDateKey(new Date()), []);
  const draft = useMemo(() => parseQuickEntry(text, today, caret), [text, today, caret]);

  const liveAccounts = useMemo(() => accounts.filter((a) => !a.archivedAt), [accounts]);

  const suggestions = useMemo(() => {
    if (draft.active === 'category') {
      return rankMatches(draft.categoryToken ?? '', categories, (c) => c.name)
        .slice(0, 6)
        .map((c) => ({ id: c.id, label: c.name, icon: c.icon }));
    }
    if (draft.active === 'account') {
      return rankMatches(draft.accountToken ?? '', liveAccounts, (a) => a.name)
        .slice(0, 6)
        .map((a) => ({ id: a.id, label: a.name, icon: undefined as string | undefined }));
    }
    return [];
  }, [draft, categories, liveAccounts]);

  // HYG-4: The highlight is a cursor into a list that just changed identity. Keeping
  // it would leave the selection pointing at a different suggestion than the
  // one the user was looking at when they pressed Enter.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setHighlight(0), [suggestions.length, draft.active]);

  useEffect(() => {
    if (!open) return;
    // HYG-4: Reset on open. The overlay stays mounted while closed (the parent renders
    // it unconditionally), so there is no unmount to clear this state. The pure
    // alternative is remounting from the parent via a key — a bigger change to
    // the caller than the lint it would remove.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setText('');
    setCaret(0);
    setSaved(null);
    // rAF rather than a bare focus(): the overlay mounts in the same frame and
    // focusing a not-yet-laid-out input silently no-ops in some engines.
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open]);

  if (!open) return null;

  // Resolution happens at save time against the same ranking the suggestions
  // used, so what the list showed first is what Enter commits.
  const resolvedCategory = draft.categoryToken
    ? rankMatches(draft.categoryToken, categories, (c) => c.name)[0]
    : undefined;
  const resolvedAccount = draft.accountToken
    ? rankMatches(draft.accountToken, liveAccounts, (a) => a.name)[0]
    : // No @token: fall back to the category's preferred account, then the
      // first live one. Matches what AddTransaction defaults to.
      liveAccounts.find((a) => a.id === resolvedCategory?.linkedManualAssetId) ??
      liveAccounts.find((a) => a.accountType === 'checking') ??
      liveAccounts[0];

  const complete = isComplete(draft);
  const money = (v: number) => formatMoney(v, baseCurrency, { locale: formatLocale() });

  const acceptSuggestion = (label: string) => {
    // Replace the active token in place, leaving everything else alone — the
    // user may have typed the description first.
    const sigil = draft.active === 'category' ? '#' : '@';
    const token = draft.active === 'category' ? draft.categoryToken : draft.accountToken;
    const needle = `${sigil}${token ?? ''}`;
    const replacement = `${sigil}${label.replace(/\s+/g, '-')}`;
    const idx = text.lastIndexOf(needle);
    const next = idx >= 0 ? text.slice(0, idx) + replacement + text.slice(idx + needle.length) : `${text} ${replacement}`;
    setText(next);
    setCaret(next.length);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const save = async () => {
    if (!complete || busy) return;
    setBusy(true);
    try {
      await addTransaction({
        amount: draft.amount as number,
        description: draft.description,
        date: draft.date,
        type: draft.type,
        categoryId: resolvedCategory?.id,
        accountId: resolvedAccount?.id,
      });
      // Stay open and clear. Logging six expenses in a row is the whole use
      // case, and closing after each one would put the pointer back in play.
      setSaved(`${draft.type === 'income' ? '+' : '−'}${money(draft.amount as number)} · ${draft.description}`);
      setText('');
      setCaret(0);
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    // While an IME is composing, every key below belongs to it: arrows walk the
    // candidate list, Tab and Enter commit the selection, Escape cancels it. Each
    // branch here also calls preventDefault(), so acting on any of them takes the
    // key away from the keyboard mid-word. Guard the whole handler, not just Enter.
    if (isComposing(e)) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }
    if (suggestions.length > 0 && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      setHighlight((h) => (h + (e.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length);
      return;
    }
    if (e.key === 'Tab' && suggestions.length > 0) {
      e.preventDefault();
      acceptSuggestion(suggestions[highlight].label);
      return;
    }
    // ime-ok: the whole handler already returns early on isComposing() above,
    // which covers this branch and the arrow/Tab/Escape ones too.
    if (e.key === 'Enter') {
      e.preventDefault();
      // Enter completes the token being typed before it commits anything —
      // otherwise a half-typed `#foo` would save under whatever it matched
      // without the user seeing the resolution.
      if (suggestions.length > 0 && draft.active) {
        acceptSuggestion(suggestions[highlight].label);
        return;
      }
      void save();
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh] px-4 bg-black/50"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label={t('fin.qa.title')}
    >
      <div className="panel w-full max-w-2xl p-3 shadow-2xl">
        <input
          ref={inputRef}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setCaret(e.target.selectionStart ?? e.target.value.length);
          }}
          onKeyUp={(e) => setCaret((e.target as HTMLInputElement).selectionStart ?? 0)}
          onClick={(e) => setCaret((e.target as HTMLInputElement).selectionStart ?? 0)}
          {...compositionTracking}
          onKeyDown={onKeyDown}
          placeholder={t('fin.qa.placeholder')}
          className="w-full bg-transparent text-lg font-heading text-text placeholder:text-text-muted/50 focus:outline-none px-2 py-1.5"
          autoComplete="off"
          spellCheck={false}
          aria-describedby="quickadd-preview"
        />

        {suggestions.length > 0 && (
          <ul className="mt-1 border-t border-border/60 pt-1" role="listbox">
            {suggestions.map((s, i) => (
              <li key={s.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={i === highlight}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    acceptSuggestion(s.label);
                  }}
                  className={`w-full text-start px-2 py-1.5 rounded-sm text-sm flex items-center gap-2 ${
                    i === highlight ? 'bg-surface2 text-text shadow-[inset_0_-2px_0_var(--signal)]' : 'text-text-muted'
                  }`}
                >
                  {s.icon && <span aria-hidden>{s.icon}</span>}
                  {s.label}
                </button>
              </li>
            ))}
          </ul>
        )}

        {/* The preview is the safety net that makes a terse syntax honest. */}
        <div id="quickadd-preview" className="mt-2 pt-2 border-t border-border/60 flex flex-wrap items-center gap-1.5 text-[0.6875rem]">
          <Chip
            tone={draft.amount != null ? (draft.type === 'income' ? 'success' : 'primary') : 'empty'}
            label={
              draft.amount != null
                ? `${draft.type === 'income' ? '+' : '−'}${money(draft.amount)}`
                : t('fin.qa.needAmount')
            }
          />
          <Chip
            tone={draft.description ? 'plain' : 'empty'}
            label={draft.description || t('fin.qa.needDescription')}
          />
          <Chip
            tone={resolvedCategory ? 'plain' : 'muted'}
            label={resolvedCategory ? `#${resolvedCategory.name}` : t('fin.qa.noCategory')}
          />
          <Chip
            tone={resolvedAccount ? 'plain' : 'danger'}
            label={resolvedAccount ? `@${resolvedAccount.name}` : t('fin.qa.noAccount')}
          />
          <Chip tone="muted" label={draft.date} />
        </div>

        <div className="mt-2 flex items-center justify-between gap-2">
          <span className="text-[0.625rem] text-text-muted">{t('fin.qa.hint')}</span>
          <div className="flex items-center gap-2">
            {saved && <span className="text-[0.6875rem] text-success truncate max-w-[240px] inline-flex items-center gap-1"><Glyph name="check" size={11} />{saved}</span>}
            <button type="button" className="btn btn-sm" disabled={!complete || !resolvedAccount || busy} onClick={() => void save()}>
              {t('fin.qa.save')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Chip({ label, tone }: { label: string; tone: 'primary' | 'success' | 'danger' | 'plain' | 'muted' | 'empty' }) {
  const cls =
    tone === 'primary'
      ? 'border-primary/40 bg-primary/10 text-primary'
      : tone === 'success'
        ? 'border-success/40 bg-success/10 text-success'
        : tone === 'danger'
          ? 'border-danger/40 bg-danger/10 text-danger'
          : tone === 'plain'
            ? 'border-border text-text'
            : tone === 'muted'
              ? 'border-border text-text-muted'
              : 'border-dashed border-border text-text-muted/70';
  return (
    <span className={`inline-flex items-center rounded-sm border px-2 py-0.5 max-w-[240px] truncate ${cls}`}>
      {label}
    </span>
  );
}
