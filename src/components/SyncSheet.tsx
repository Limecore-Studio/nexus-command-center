// v1.22 (NCC#290) — what the header's sync dot opens: the state in plain
// words, when the last sync was, Sync now, and the way to Settings. Loaded on
// demand by SyncDot.
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import BottomSheet from './BottomSheet';
import { useSyncStore } from '../store/useSyncStore';
import { conversionPending } from '../lib/currencyConversionMarker';
import { formatLocale } from '../utils/formatters';
import type { SyncTone } from '../lib/syncTone';

export default function SyncSheet({ tone, onClose }: { tone: SyncTone; onClose: () => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const isOnline = useSyncStore((s) => s.isOnline);
  const pendingCount = useSyncStore((s) => s.pendingCount);
  const lastSyncedAt = useSyncStore((s) => s.lastSyncedAt);
  const syncing = useSyncStore((s) => s.syncing);
  const syncNow = useSyncStore((s) => s.syncNow);

  const lines: string[] = [];
  if (tone === 'failed') lines.push(t(conversionPending() ? 'sync.conversion' : 'sync.failed'));
  if (!isOnline) lines.push(t('sync.offline'));
  if (pendingCount > 0) lines.push(t('sync.pending', { count: pendingCount }));
  if (lines.length === 0) lines.push(t('sync.allSynced'));

  const last = lastSyncedAt
    ? new Intl.DateTimeFormat(formatLocale(), { hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' }).format(new Date(lastSyncedAt))
    : t('sync.never');

  return (
    <BottomSheet open onClose={onClose} title={t('sync.status')}>
      <div className="space-y-3">
        {lines.map((l) => (
          <p key={l} className="text-sm">{l}</p>
        ))}
        <p className="text-xs text-text-muted">
          {t('settings.lastSync')}: {last}
        </p>
        <button className="btn w-full" onClick={() => void syncNow()} disabled={syncing || !isOnline}>
          {syncing ? t('settings.syncing') : t('settings.syncNow')}
        </button>
        <button
          className="btn-ghost w-full"
          onClick={() => {
            onClose();
            navigate('/settings');
          }}
        >
          {t('settings.dataSync')}
        </button>
      </div>
    </BottomSheet>
  );
}
