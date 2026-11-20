// v1.22 (StudyDesk#260, NCC half) — a one-time note on the Dashboard: NCC
// also runs on a computer, with the same account. Loaded lazily, only when it
// is due (lib/computerApps.computerNoteDue), so it stays out of the startup
// bundle.
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { dismissComputerNote } from '../lib/computerApps';

export default function ComputerAppsNote({ userId, onDone }: { userId: string; onDone: () => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const close = () => {
    dismissComputerNote(userId);
    onDone();
  };
  return (
    <section className="card" aria-labelledby="computer-note-title">
      <h2 id="computer-note-title" className="font-heading font-bold text-sm mb-1">
        {t('dash.computerNoteTitle')}
      </h2>
      <p className="text-xs text-text-muted mb-3">{t('dash.computerNoteBody')}</p>
      <div className="flex gap-2 justify-end">
        <button className="btn-ghost px-3 py-1.5 text-xs" onClick={close}>
          {t('dash.computerNoteDismiss')}
        </button>
        <button
          className="btn px-3 py-1.5 text-xs"
          onClick={() => {
            close();
            navigate('/settings', { state: { scrollTo: 'computer' } });
          }}
        >
          {t('dash.computerNoteOpen')}
        </button>
      </div>
    </section>
  );
}
