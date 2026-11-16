import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { pendingConsent, setConsent, type ConsentTopic } from '../lib/usageConsent';
import { setUpdateCheckEnabled } from '../lib/fdroidUpdate';
import '../i18n/lazy/consent'; // consent.* (loaded with this card)

// v1.21.1 (limecore#87) — asks, once per owner, for the two optional checks:
// the F-Droid update check (Android, from the first launch) and the app-open
// record (after sign-in). Both stay off until the answer is yes. AppShell
// loads this on demand; it decides for itself (lib/usageConsent.ts). Same
// placement and drawing as ReportPromptCard, which waits while this is up.
const SHOW_AFTER_MS = 4000;

export default function ConsentPromptCard() {
  const { t } = useTranslation();
  const [queue, setQueue] = useState<ConsentTopic[]>([]);
  const [total, setTotal] = useState(0);

  useEffect(() => {
    const id = setTimeout(() => {
      const pending = pendingConsent();
      setQueue(pending);
      setTotal(pending.length);
    }, SHOW_AFTER_MS);
    return () => clearTimeout(id);
  }, []);

  const topic = queue[0];
  if (!topic) return null;
  const answer = (yes: boolean) => {
    if (topic === 'updateCheck') setUpdateCheckEnabled(yes);
    else setConsent(topic, yes);
    setQueue(queue.slice(1));
  };
  const isUpdate = topic === 'updateCheck';
  return (
    <div className="fixed z-50 inset-x-3 bottom-28 md:inset-x-auto md:right-6 md:bottom-6 md:w-96 safe-bottom">
      <aside key={topic} role="dialog" aria-labelledby="cp-title" className="panel p-4 animate-fade-in-up shadow-lg">
        {total > 1 && <div className="sec">{t('consent.step', { n: total - queue.length + 1, total })}</div>}
        <h2 id="cp-title" className="font-heading font-semibold text-base text-text mt-0.5">
          {isUpdate ? t('consent.updateTitle') : t('consent.opensTitle')}
        </h2>
        <p className="text-xs text-text-muted mt-1.5 leading-relaxed">
          {isUpdate ? t('consent.updateBody') : t('consent.opensBody')}
        </p>
        <div className="flex justify-end gap-2 mt-3">
          <button type="button" className="btn-ghost btn-sm" onClick={() => answer(false)}>{t('consent.no')}</button>
          <button type="button" className="btn btn-sm" onClick={() => answer(true)}>{t('consent.yes')}</button>
        </div>
      </aside>
    </div>
  );
}
