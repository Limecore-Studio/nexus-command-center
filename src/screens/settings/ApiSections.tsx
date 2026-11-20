import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useConfirm } from '../../components/ConfirmDialog';
import ListRow from '../../components/ListRow';
import Glyph from '../../components/Glyph';
import { setApiKey, clearApiKey, maskKey } from '../../api/keys';
import { allBudgetStats, type BudgetStats } from '../../api/cache';
import { Section } from './parts';

// Settings > API keys and Settings > API usage today. Split out of
// Settings.tsx with their state (limecore#12).
export function ApiKeysSection() {
  const confirm = useConfirm();
  const { t } = useTranslation();
  const [finnhubKey, setFinnhubKey] = useState('');
  const [finnhubKey2, setFinnhubKey2] = useState('');
  // Which slot the user is currently editing — null means no editor open.
  const [editingSlot, setEditingSlot] = useState<null | 'finnhub' | 'finnhub2'>(null);
  const [keyDraft, setKeyDraft] = useState('');

  useEffect(() => {
    // Read both slots separately (getApiKey('finnhub') without the slot name
    // would round-robin and obscure which one is empty in the UI).
    void (async () => {
      const { Preferences } = await import('@capacitor/preferences');
      try {
        const k1 = await Preferences.get({ key: 'apikey_finnhub' });
        const k2 = await Preferences.get({ key: 'apikey_finnhub2' });
        setFinnhubKey(k1.value ?? '');
        setFinnhubKey2(k2.value ?? '');
      } catch {
        setFinnhubKey(localStorage.getItem('apikey_finnhub') ?? '');
        setFinnhubKey2(localStorage.getItem('apikey_finnhub2') ?? '');
      }
    })();
  }, []);

  const onSaveKey = async () => {
    if (!editingSlot || !keyDraft.trim()) return;
    await setApiKey(editingSlot, keyDraft.trim());
    if (editingSlot === 'finnhub') setFinnhubKey(keyDraft.trim());
    else setFinnhubKey2(keyDraft.trim());
    setEditingSlot(null);
    setKeyDraft('');
  };

  const onClearKey = async (slot: 'finnhub' | 'finnhub2') => {
    if (!(await confirm({ message: t('settings.clearKeyConfirm') }))) return;
    await clearApiKey(slot);
    if (slot === 'finnhub') setFinnhubKey('');
    else setFinnhubKey2('');
  };

  return (
    <Section title={t('settings.apiKeys')}>
      {editingSlot ? (
        <div className="space-y-2 py-2">
          <div className="text-[0.625rem] uppercase tracking-wider text-text-muted">
            {editingSlot === 'finnhub' ? t('settings.finnhubSlot1') : t('settings.finnhubSlot2')}
          </div>
          <input
            className="input"
            placeholder={t('settings.finnhubPlaceholder')}
            value={keyDraft}
            onChange={(e) => setKeyDraft(e.target.value)}
            autoFocus
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
          <div className="flex gap-2">
            <button className="btn flex-1" onClick={onSaveKey}>
              {t('common.save')}
            </button>
            <button
              className="btn-ghost flex-1"
              onClick={() => setEditingSlot(null)}
            >
              {t('common.cancel')}
            </button>
          </div>
          <div className="text-[0.625rem] text-text-muted">
            {t('settings.finnhubHelp')}
          </div>
        </div>
      ) : (
        <>
          {!finnhubKey && !finnhubKey2 && (
            <div className="alert alert-warn text-xs mb-2">
              <span className="w-2 h-2 rounded-full bg-warning" />
              <span className="flex-1">
                {t('settings.noFinnhubKey')}
              </span>
            </div>
          )}
          <FinnhubKeyRow
            label={t('settings.finnhubKey1')}
            value={finnhubKey}
            onEdit={() => {
              setKeyDraft('');
              setEditingSlot('finnhub');
            }}
            onClear={() => onClearKey('finnhub')}
          />
          <FinnhubKeyRow
            label={t('settings.finnhubKey2')}
            value={finnhubKey2}
            onEdit={() => {
              setKeyDraft('');
              setEditingSlot('finnhub2');
            }}
            onClear={() => onClearKey('finnhub2')}
          />
          <div className="text-[0.625rem] text-text-muted py-1 px-1">
            {t('settings.twoSlots')}
          </div>
          <ListRow label="CoinGecko" tag={{ text: t('settings.tagFree'), tone: 'green' }} />
          <ListRow label="Yahoo Finance" tag={{ text: t('settings.tagFreeFallback'), tone: 'green' }} />
          <ListRow label="Health Connect" tag={{ text: t('settings.tagSamsung'), tone: 'muted' }} />
        </>
      )}
    </Section>
  );
}

export function ApiUsageSection() {
  const { t } = useTranslation();
  const [budgets, setBudgets] = useState<BudgetStats[]>([]);

  useEffect(() => {
    // HYG-4: The initial read pairs with the 5s interval below; both write the same
    // state, and dropping this one would leave the panel blank until the first
    // tick.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setBudgets(allBudgetStats());
    // Refresh budget meters every 5s while the screen is open so the user
    // sees usage tick up as the app fires background refreshes.
    const id = setInterval(() => setBudgets(allBudgetStats()), 5000);
    return () => clearInterval(id);
  }, []);

  return (
    <Section title={t('settings.apiUsageToday')}>
      {budgets.map((b) => {
        const pct = b.max > 0 ? Math.min(100, (b.used / b.max) * 100) : 0;
        const exhausted = b.used >= b.max;
        return (
          <div key={b.provider} className="py-2">
            <div className="flex items-center justify-between text-xs">
              <span className="capitalize">{b.provider}</span>
              <span className={exhausted ? 'text-danger' : 'text-text-muted'}>
                {b.used} / {b.max}
              </span>
            </div>
            <div className="h-1 bg-surface2 rounded-sm mt-1 overflow-hidden">
              <div
                className={`h-full ${exhausted ? 'bg-danger' : pct > 75 ? 'bg-warning' : 'bg-text-muted'}`}
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        );
      })}
      <div className="text-[0.625rem] text-text-muted">
        {t('settings.apiUsageResets')}
      </div>
    </Section>
  );
}

// Row for one Finnhub key slot. Shows masked value + "Set" button when empty,
// or masked value + edit/remove actions when populated. Keeps the visual
// uniform between filled and empty so users see the slot exists.
function FinnhubKeyRow({
  label,
  value,
  onEdit,
  onClear,
}: {
  label: string;
  value: string;
  onEdit: () => void;
  onClear: () => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="py-2 flex items-center justify-between gap-2">
      <div className="min-w-0">
        <div className="text-sm">{label}</div>
        <div className={`text-[0.625rem] ${value ? 'text-text-muted' : 'text-warning'}`}>
          {value ? maskKey(value) : t('settings.notSet')}
        </div>
      </div>
      <div className="flex gap-1 flex-shrink-0">
        <button
          onClick={onEdit}
          className="chip-micro py-1 press-spring"
        >
          {value ? t('common.edit') : t('settings.set')}
        </button>
        {value && (
          <button
            onClick={onClear}
            aria-label={t('common.delete')}
            className="chip-micro py-1 active:text-danger active:border-danger"
          >
            <Glyph name="close" size={11} />
          </button>
        )}
      </div>
    </div>
  );
}
