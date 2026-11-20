import { useTranslation } from 'react-i18next';
import { useConfirm } from './ConfirmDialog';
import Glyph from './Glyph';
interface RowActionsProps {
  onEdit?: () => void;
  onDelete?: () => void;
  onShare?: () => void;
  confirmMsg?: string;
  /** v1.22 (NCC#293): delete at once, no confirm; the caller offers Undo. */
  noConfirm?: boolean;
}

export default function RowActions({ onEdit, onDelete, onShare, confirmMsg, noConfirm }: RowActionsProps) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  return (
    <div className="flex items-center gap-1 flex-shrink-0">
      {onShare && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onShare();
          }}
          className="text-text-muted hover:text-primary active:text-text text-xs px-2 py-1 rounded-sm border border-border active:bg-surface2"
          aria-label={t('common.share')}
          title={t('common.share')}
        >
          ⇆
        </button>
      )}
      {onEdit && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onEdit();
          }}
          className="text-text-muted hover:text-primary active:text-text text-xs px-2 py-1 rounded-sm border border-border active:bg-surface2"
          aria-label={t('common.edit')}
          title={t('common.edit')}
        >
          <Glyph name="edit" size={12} />
        </button>
      )}
      {onDelete && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            if (noConfirm) {
              onDelete();
              return;
            }
            void (async () => {
              // confirmMsg is optional; callers that pass nothing get the
              // generic translated prompt rather than the old English default.
              if (await confirm({ message: confirmMsg ?? t('common.deleteItem') })) onDelete();
            })();
          }}
          className="text-text-muted hover:text-danger active:text-danger text-xs px-2 py-1 rounded-sm border border-border active:bg-danger/10"
          aria-label={t('common.delete')}
          title={t('common.delete')}
        >
          <Glyph name="close" size={12} />
        </button>
      )}
    </div>
  );
}
