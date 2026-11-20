// v1.22 (NCC#293) — "Deleted · Undo", shown for the undo window after a
// transaction or task is deleted (store/useUndoStore). Loaded by AppShell only
// while a delete waits.
import { useTranslation } from 'react-i18next';
import { undoPendingDelete, useUndoStore } from '../store/useUndoStore';

export default function UndoBar() {
  const { t } = useTranslation();
  const pending = useUndoStore((s) => s.pending);
  if (!pending) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed left-1/2 -translate-x-1/2 bottom-[calc(6rem+env(safe-area-inset-bottom))] z-50 w-[calc(100%-2rem)] max-w-sm card-elevated flex items-center gap-3 py-2.5 px-3"
    >
      <span className="text-sm flex-1 min-w-0 truncate">{t('undo.deleted', { name: pending.label })}</span>
      <button className="chip text-primary border-primary/40 flex-shrink-0" onClick={undoPendingDelete}>
        {t('undo.undo')}
      </button>
    </div>
  );
}
