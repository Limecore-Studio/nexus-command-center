// v1.22 (limecore#131) — a small "Open in StudyDesk / LimeLog" link on a card
// that shows that app's data. lib/suiteApps loads on the first tap.
import { useTranslation } from 'react-i18next';
import type { SuiteApp } from '../lib/suiteApps';

export default function SuiteAppLink({ app, route, className = '' }: { app: SuiteApp; route: string; className?: string }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      className={`chip-micro ${className}`}
      onClick={(e) => {
        e.stopPropagation();
        void import('../lib/suiteApps').then((m) => m.openInSuiteApp(app, route));
      }}
    >
      {t(app === 'studydesk' ? 'suite.openStudyDesk' : 'suite.openLimeLog')} ↗
    </button>
  );
}
