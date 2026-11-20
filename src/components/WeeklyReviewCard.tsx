// v1.22 (NCC#278) — Sunday's "your week in review" card on Home. Loaded by the
// Dashboard only when it is due (lib/reviewCard). Opening the review or the ×
// both dismiss it for the week.
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { dismissReviewCard } from '../lib/reviewCard';
import Glyph from './Glyph';

export default function WeeklyReviewCard({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const close = () => {
    dismissReviewCard();
    onDone();
  };
  return (
    <section className="card" aria-labelledby="review-card-title">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 id="review-card-title" className="font-heading font-bold text-sm inline-flex items-center gap-1.5">
            <Glyph name="calendar" size={13} className="text-text-muted" />
            {t('dash.reviewReadyTitle')}
          </h2>
          <p className="text-xs text-text-muted mt-1">{t('dash.reviewReadySub')}</p>
        </div>
        <button className="chip-micro py-1 flex-shrink-0" onClick={close} aria-label={t('common.close')}>
          <Glyph name="close" size={11} />
        </button>
      </div>
      <div className="flex justify-end mt-3">
        <button
          className="btn px-3 py-1.5 text-xs"
          onClick={() => {
            close();
            navigate('/review');
          }}
        >
          {t('dash.reviewReadyOpen')}
        </button>
      </div>
    </section>
  );
}
