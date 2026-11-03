import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { answerReportPrompt, noteSignedInLaunch, shouldAskForReports } from '../lib/reportPrompt';

// v1.20 (limecore#71) — the one-time card that offers error reports. AppShell
// mounts it for a signed-in user only and loads it on demand; it counts the
// launch and decides for itself (lib/reportPrompt.ts), and appears a few
// seconds in so it never lands on top of the first screen. Floats above the
// tab bar on phones, bottom-right on wider screens.
const SHOW_AFTER_MS = 4000;

export default function ReportPromptCard() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    noteSignedInLaunch();
    if (!shouldAskForReports()) return undefined;
    const id = setTimeout(() => setOpen(true), SHOW_AFTER_MS);
    return () => clearTimeout(id);
  }, []);

  if (!open) return null;
  const answer = (yes: boolean) => {
    answerReportPrompt(yes);
    setOpen(false);
  };
  return (
    <div className="fixed z-50 inset-x-3 bottom-28 md:inset-x-auto md:right-6 md:bottom-6 md:w-96 safe-bottom">
      <aside role="dialog" aria-labelledby="rp-title" className="panel p-4 animate-fade-in-up shadow-lg">
        <h2 id="rp-title" className="font-heading font-semibold text-base text-text">{t('reportPrompt.title')}</h2>
        <p className="text-xs text-text-muted mt-1.5 leading-relaxed">{t('reportPrompt.body')}</p>
        <div className="flex justify-end gap-2 mt-3">
          <button type="button" className="btn-ghost btn-sm" onClick={() => answer(false)}>{t('reportPrompt.notNow')}</button>
          <button type="button" className="btn btn-sm" onClick={() => answer(true)}>{t('reportPrompt.yes')}</button>
        </div>
      </aside>
    </div>
  );
}
