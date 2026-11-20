// v1.22 (NCC#290) — sync state as a quiet dot in the app header, on every
// screen. Hidden while all is well; amber with a count while writes wait or
// the device is offline; red when the last sync failed or a currency
// conversion is waiting. It replaces the always-on green banner on Home, which
// never showed a failure. Tapping opens SyncSheet (loaded on demand).
import { lazy, Suspense, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSyncStore } from '../store/useSyncStore';
import { useSessionStore } from '../store/useSessionStore';
import { conversionPending } from '../lib/currencyConversionMarker';
import { syncTone } from '../lib/syncTone';

const SyncSheet = lazy(() => import('./SyncSheet'));

export default function SyncDot() {
  const { t } = useTranslation();
  const signedIn = useSessionStore((s) => Boolean(s.user));
  const isOnline = useSyncStore((s) => s.isOnline);
  const pendingCount = useSyncStore((s) => s.pendingCount);
  const lastError = useSyncStore((s) => s.lastError);
  const [open, setOpen] = useState(false);
  const tone = syncTone({ signedIn, isOnline, pendingCount, lastError, conversion: signedIn && conversionPending() });
  if (tone === 'ok' && !open) return null;

  return (
    <>
      {tone !== 'ok' && (
        <button
          onClick={() => setOpen(true)}
          className="h-9 min-w-9 px-2 rounded-full flex items-center justify-center gap-1 press-spring flex-shrink-0"
          aria-label={t('sync.status')}
        >
          <span className={`w-2 h-2 rounded-full ${tone === 'failed' ? 'bg-danger' : 'bg-warning'}`} />
          {tone === 'pending' && pendingCount > 0 && (
            <span className="font-mono text-[0.625rem] text-text-muted">{pendingCount}</span>
          )}
        </button>
      )}
      {open && (
        <Suspense fallback={null}>
          <SyncSheet tone={tone} onClose={() => setOpen(false)} />
        </Suspense>
      )}
    </>
  );
}
