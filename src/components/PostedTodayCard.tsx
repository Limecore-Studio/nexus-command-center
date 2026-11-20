// v1.22 (NCC#294) — recurring rules post rent, subscriptions and salary on
// launch without a word. On a day something was posted, Home shows it once:
// "Posted today: Rent −€800 · Spotify −€11". Each item opens its transaction;
// the card is gone after dismiss or at midnight. Loaded by the Dashboard only
// when there is something to show (lib/postedToday).
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import type { Transaction } from '../types/finance';
import { formatCurrency } from '../utils/formatters';
import { dismissPostedToday } from '../lib/postedToday';
import Glyph from './Glyph';

export default function PostedTodayCard({ items, baseCurrency, onDone }: { items: Transaction[]; baseCurrency: string; onDone: () => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const close = () => {
    dismissPostedToday();
    onDone();
  };
  return (
    <section className="card" aria-labelledby="posted-today-title">
      <div className="flex items-start justify-between gap-2 mb-1">
        <div>
          <h2 id="posted-today-title" className="font-heading font-bold text-sm">{t('dash.postedToday')}</h2>
          <p className="text-[0.625rem] text-text-muted">{t('dash.postedTodaySub')}</p>
        </div>
        <button className="chip-micro py-1 flex-shrink-0" onClick={close} aria-label={t('common.close')}>
          <Glyph name="close" size={11} />
        </button>
      </div>
      <ul className="mt-2 space-y-1">
        {items.map((tx) => (
          <li key={tx.id}>
            <button
              className="w-full flex items-center justify-between gap-3 py-1.5 text-left active:opacity-80"
              onClick={() => {
                close();
                navigate(`/finance/add?id=${tx.id}`);
              }}
            >
              <span className="text-sm truncate">{tx.description}</span>
              <span className={`text-sm whitespace-nowrap ${tx.type === 'income' ? 'text-success' : 'text-text-muted'}`}>
                {tx.type === 'income' ? '+' : '−'}
                {formatCurrency(tx.amount, baseCurrency)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
