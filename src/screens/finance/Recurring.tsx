import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import AppHeader from '../../components/AppHeader';
import Glyph from '../../components/Glyph';
import { useFinanceStore } from '../../store/useFinanceStore';
import { useRecurringStore, type RecurringRuleInput } from '../../store/useRecurringStore';
import { useSettingsStore } from '../../store/useSettingsStore';
import { formatMoney, type BaseCurrency } from '../../lib/currencies';
import { nextOccurrence } from '../../lib/recurring';
import { isRewardLot } from '../../lib/recurringMaterialize';
import { formatLocale, formatShortDate, localDateKey, parseDateLocal } from '../../utils/formatters';
import { numberInput } from '@/lib/numberInput';
import type { RecurringKind, RecurringRule, RecurringUnit } from '../../types/recurring';
import type { TransactionType } from '../../types/finance';

// v1.19 — NCC#202: recurring rules. One list, one inline editor (the
// ManageBudgets pattern). Rows a rule has already written are ordinary rows:
// editing a rule changes what comes next, never what is already there.
//
// Opened with ?new=transaction|cash_deposit|buy|yield (and &holding=<id>) from
// Add Transaction, the portfolio cash card and a holding's lots screen.
//
// v1.20 (NCC#203): `yield` accrues a holding's staking rewards from its APY.
// It always runs daily, so the editor shows no cadence for it.

const KINDS: Exclude<RecurringKind, 'coupon'>[] = ['transaction', 'cash_deposit', 'buy', 'yield'];
const UNITS: RecurringUnit[] = ['day', 'week', 'month'];
const TX_TYPES: TransactionType[] = ['expense', 'income', 'transfer'];

interface Draft {
  kind: RecurringKind;
  txType: TransactionType;
  amount: string;
  description: string;
  accountId: string;
  destinationAccountId: string;
  categoryId: string;
  holdingId: string;
  buyBy: 'amount' | 'quantity';
  priceMode: 'market' | 'fixed';
  price: string;
  currency: string;
  /** v1.20 (NCC#203): yield, annual % */
  apy: string;
  every: string;
  unit: RecurringUnit;
  startDate: string;
  endDate: string;
}

const today = () => localDateKey(new Date());

function emptyDraft(kind: RecurringKind, baseCurrency: string, holdingId = ''): Draft {
  return {
    kind, txType: 'expense', amount: '', description: '', accountId: '', destinationAccountId: '',
    categoryId: '', holdingId, buyBy: 'amount', priceMode: 'market', price: '', currency: baseCurrency,
    apy: '', every: '1', unit: 'month', startDate: today(), endDate: '',
  };
}

/** v1.19 (NCC#204): coupon rules belong to their bond (bondCoupons.ts) and
 *  are not listed or edited here. */
type EditableRule = Exclude<RecurringRule, { kind: 'coupon' }>;
const isEditable = (r: RecurringRule): r is EditableRule => r.kind !== 'coupon';

function draftOf(r: EditableRule, baseCurrency: string): Draft {
  const d = emptyDraft(r.kind, baseCurrency);
  Object.assign(d, { every: String(r.every), unit: r.unit, startDate: r.startDate, endDate: r.endDate ?? '' });
  if (r.kind === 'transaction') {
    const t = r.template;
    Object.assign(d, {
      txType: t.type, amount: String(t.amount), description: t.description, accountId: t.accountId ?? '',
      destinationAccountId: t.destinationAccountId ?? '', categoryId: t.categoryId ?? '',
    });
  } else if (r.kind === 'cash_deposit') {
    Object.assign(d, { accountId: r.template.accountId, amount: String(r.template.amount), description: r.template.note ?? '' });
  } else if (r.kind === 'yield') {
    Object.assign(d, { holdingId: r.template.holdingId, apy: String(r.template.apyPct), currency: r.template.currency });
  } else {
    const t = r.template;
    Object.assign(d, {
      holdingId: t.holdingId, buyBy: t.quantity ? 'quantity' : 'amount',
      amount: String(t.quantity ?? t.amount ?? ''), priceMode: t.priceMode, price: t.price != null ? String(t.price) : '',
      currency: t.currency, description: t.note ?? '',
    });
  }
  return d;
}

/** The rule the draft describes, or null while it is incomplete. */
function inputOf(d: Draft): RecurringRuleInput | null {
  if (!d.startDate || (d.endDate && d.endDate < d.startDate)) return null;
  if (d.kind === 'yield') {
    const apyPct = numberInput(d.apy);
    if (!d.holdingId || !d.currency || !(apyPct > 0 && apyPct <= 1000)) return null;
    return {
      every: 1, unit: 'day', startDate: d.startDate, endDate: d.endDate || undefined,
      kind: 'yield', template: { holdingId: d.holdingId, apyPct, currency: d.currency },
    };
  }
  const every = Math.round(Number(d.every));
  const amount = numberInput(d.amount);
  if (!(every >= 1 && every <= 366) || !d.startDate || !(amount && amount > 0)) return null;
  if (d.endDate && d.endDate < d.startDate) return null;
  const cadence = {
    every, unit: d.unit, startDate: d.startDate, endDate: d.endDate || undefined,
    anchorDay: d.unit === 'month' ? parseDateLocal(d.startDate).getDate() : undefined,
  };
  if (d.kind === 'transaction') {
    if (!d.description.trim() || !d.accountId) return null;
    if (d.txType === 'transfer' && (!d.destinationAccountId || d.destinationAccountId === d.accountId)) return null;
    return {
      ...cadence, kind: 'transaction',
      template: {
        type: d.txType, amount, description: d.description.trim(), accountId: d.accountId,
        destinationAccountId: d.txType === 'transfer' ? d.destinationAccountId : undefined,
        categoryId: d.txType === 'expense' && d.categoryId ? d.categoryId : undefined,
      },
    };
  }
  if (d.kind === 'cash_deposit') {
    if (!d.accountId) return null;
    return { ...cadence, kind: 'cash_deposit', template: { accountId: d.accountId, amount, note: d.description.trim() || undefined } };
  }
  if (!d.holdingId || !d.currency) return null;
  const price = d.priceMode === 'fixed' ? numberInput(d.price) : undefined;
  if (d.priceMode === 'fixed' && !(price && price > 0)) return null;
  return {
    ...cadence, kind: 'buy',
    template: {
      holdingId: d.holdingId, priceMode: d.priceMode, price, currency: d.currency,
      quantity: d.buyBy === 'quantity' ? amount : undefined,
      amount: d.buyBy === 'amount' ? amount : undefined,
      note: d.description.trim() || undefined,
    },
  };
}

/** A segmented control in the app's pill language. */
function Segmented<T extends string>({ value, options, label, onChange }: {
  value: T; options: T[]; label: (o: T) => string; onChange: (o: T) => void;
}) {
  return (
    <div className="panel-2 p-0.5 flex text-[0.6875rem] font-heading font-semibold" role="radiogroup">
      {options.map((o) => (
        <button
          key={o}
          type="button"
          role="radio"
          aria-checked={value === o}
          onClick={() => onChange(o)}
          className={`flex-1 px-2 py-1.5 rounded-sm transition-colors duration-200 ${
            value === o ? 'bg-surface2 text-text shadow-[inset_0_-2px_0_var(--signal)]' : 'text-text-muted'
          }`}
        >
          {label(o)}
        </button>
      ))}
    </div>
  );
}

export default function Recurring() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const baseCurrency = useSettingsStore((s) => s.baseCurrency);
  const accounts = useFinanceStore((s) => s.manualAssets);
  const categories = useFinanceStore((s) => s.budgetCategories);
  const holdings = useFinanceStore((s) => s.holdings);
  const lots = useFinanceStore((s) => s.portfolioLots);
  const rules = useRecurringStore((s) => s.rules);
  const { add, update, pause, resume, remove, countGenerated, load } = useRecurringStore();

  const [draft, setDraft] = useState<Draft | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<{ id: string; count: number } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void load();
  }, [load]);

  // Deep link from another screen: open the editor on that kind, once.
  useEffect(() => {
    const kind = params.get('new') as (typeof KINDS)[number] | null;
    if (!kind || !KINDS.includes(kind)) return;
    const holding = params.get('holding') ?? '';
    const h = holdings.find((x) => x.id === holding);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot hand-off from the URL, cleared right after
    setDraft({ ...emptyDraft(kind, baseCurrency, holding), currency: h?.costCurrency ?? baseCurrency });
    setEditingId(null);
    setParams({}, { replace: true });
  }, [params, setParams, baseCurrency, holdings]);

  const set = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  // v1.20 (NCC#203): yield accrues on recorded purchases, so it needs at
  // least one (see writeYield for why a holding without lots must wait).
  const yieldNeedsLots = draft?.kind === 'yield' && Boolean(draft.holdingId)
    && !lots.some((l) => l.holdingId === draft.holdingId && !isRewardLot(l));
  const ready = draft && !yieldNeedsLots ? inputOf(draft) : null;
  const preview = ready ? nextOccurrence(ready, undefined) : undefined;
  const firstDue = preview && preview <= today();

  const save = async () => {
    if (!ready) return;
    setBusy(true);
    try {
      if (editingId) await update(editingId, ready);
      else await add(ready);
      setDraft(null);
      setEditingId(null);
    } finally {
      setBusy(false);
    }
  };

  const askDelete = async (r: RecurringRule) => {
    setDeleting({ id: r.id, count: await countGenerated(r.id) });
  };

  const money = (n: number, ccy: BaseCurrency = baseCurrency) => formatMoney(n, ccy, { locale: formatLocale() });
  const cadenceText = (r: Pick<RecurringRule, 'every' | 'unit'>) => t(`recurring.every_${r.unit}`, { count: r.every });

  const rows = useMemo(
    () =>
      rules.filter(isEditable).map((r) => {
        const next = r.pausedAt ? undefined : nextOccurrence(r, r.lastMaterializedDate);
        let title: string;
        let amount: string;
        let sign: '+' | '−' | '' = '';
        let icon: string;
        if (r.kind === 'transaction') {
          title = r.template.description;
          amount = money(r.template.amount);
          sign = r.template.type === 'income' ? '+' : r.template.type === 'expense' ? '−' : '';
          icon = r.template.type === 'income' ? 'cash' : r.template.type === 'expense' ? 'expense' : 'bank';
        } else if (r.kind === 'cash_deposit') {
          const a = accounts.find((x) => x.id === r.template.accountId);
          title = t('recurring.depositFrom', { name: a?.name ?? '—' });
          amount = money(r.template.amount);
          icon = 'investment';
        } else if (r.kind === 'yield') {
          const h = holdings.find((x) => x.id === r.template.holdingId);
          title = t('recurring.yieldOn', { name: h?.ticker ?? '—' });
          amount = t('recurring.apyValue', { pct: new Intl.NumberFormat(formatLocale(), { maximumFractionDigits: 2 }).format(r.template.apyPct) });
          sign = '+';
          icon = 'lots';
        } else {
          const h = holdings.find((x) => x.id === r.template.holdingId);
          title = t('recurring.buyOf', { name: h?.ticker ?? '—' });
          amount = r.template.quantity
            ? t('recurring.units', { count: r.template.quantity })
            : money(r.template.amount ?? 0, r.template.currency as BaseCurrency);
          icon = 'lots';
        }
        return { r, next, title, amount, sign, icon };
      }),
    // money() reads baseCurrency, a dependency below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rules, accounts, holdings, baseCurrency, t],
  );

  const accountOptions = accounts.map((a) => (
    <option key={a.id} value={a.id}>
      {a.name} ({a.currency})
    </option>
  ));

  return (
    <>
      <AppHeader
        title={t('recurring.title')}
        back="/finance"
        backLabel={t('fin.finance')}
        showAvatar={false}
        action={
          !draft && (
            <button
              onClick={() => {
                setDraft(emptyDraft('transaction', baseCurrency));
                setEditingId(null);
              }}
              className="chip press-spring"
            >
              {t('recurring.new')}
            </button>
          )
        }
      />
      <div className="space-y-3">
        {draft && (
          <div className="card space-y-3">
            <div className="font-heading font-semibold text-sm">
              {editingId ? t('recurring.editTitle') : t('recurring.newTitle')}
            </div>
            {!editingId && (
              <Segmented
                value={draft.kind}
                options={KINDS}
                label={(k) => t(`recurring.kind_${k}`)}
                onChange={(kind) => set({ kind })}
              />
            )}

            {draft.kind === 'transaction' && (
              <>
                <Segmented
                  value={draft.txType}
                  options={TX_TYPES}
                  label={(k) => t(`recurring.type_${k}`)}
                  onChange={(txType) => set({ txType })}
                />
                <input className="input" placeholder={t('recurring.description')} value={draft.description}
                  onChange={(e) => set({ description: e.target.value })} />
                <input className="input" inputMode="decimal" value={draft.amount}
                  placeholder={t('recurring.amountIn', { currency: baseCurrency })}
                  onChange={(e) => set({ amount: e.target.value })} />
                <label className="block">
                  <span className="sec mb-1 block">{draft.txType === 'transfer' ? t('recurring.fromAccount') : t('recurring.account')}</span>
                  <select className="input w-full" value={draft.accountId} onChange={(e) => set({ accountId: e.target.value })}>
                    <option value="">{t('recurring.choose')}</option>
                    {accountOptions}
                  </select>
                </label>
                {draft.txType === 'transfer' && (
                  <label className="block">
                    <span className="sec mb-1 block">{t('recurring.toAccount')}</span>
                    <select className="input w-full" value={draft.destinationAccountId}
                      onChange={(e) => set({ destinationAccountId: e.target.value })}>
                      <option value="">{t('recurring.choose')}</option>
                      {accountOptions}
                    </select>
                  </label>
                )}
                {draft.txType === 'expense' && (
                  <label className="block">
                    <span className="sec mb-1 block">{t('recurring.category')}</span>
                    <select className="input w-full" value={draft.categoryId} onChange={(e) => set({ categoryId: e.target.value })}>
                      <option value="">{t('recurring.none')}</option>
                      {categories.map((c) => (
                        <option key={c.id} value={c.id}>{c.name}</option>
                      ))}
                    </select>
                  </label>
                )}
              </>
            )}

            {draft.kind === 'cash_deposit' && (
              <>
                <label className="block">
                  <span className="sec mb-1 block">{t('recurring.fromAccount')}</span>
                  <select className="input w-full" value={draft.accountId} onChange={(e) => set({ accountId: e.target.value })}>
                    <option value="">{t('recurring.choose')}</option>
                    {accountOptions}
                  </select>
                </label>
                <input className="input" inputMode="decimal" value={draft.amount}
                  placeholder={t('recurring.amountIn', { currency: baseCurrency })}
                  onChange={(e) => set({ amount: e.target.value })} />
                <input className="input" placeholder={t('recurring.noteOptional')} value={draft.description}
                  onChange={(e) => set({ description: e.target.value })} />
                <p className="text-[0.625rem] text-text-muted">{t('recurring.depositHint')}</p>
              </>
            )}

            {(draft.kind === 'buy' || draft.kind === 'yield') && (
              <label className="block">
                  <span className="sec mb-1 block">{t('recurring.holding')}</span>
                  <select className="input w-full" value={draft.holdingId}
                    onChange={(e) => {
                      const h = holdings.find((x) => x.id === e.target.value);
                      set({ holdingId: e.target.value, currency: h?.costCurrency ?? draft.currency });
                    }}>
                    <option value="">{t('recurring.choose')}</option>
                    {holdings.map((h) => (
                      <option key={h.id} value={h.id}>{h.ticker}{h.name && h.name !== h.ticker ? ` · ${h.name}` : ''}</option>
                    ))}
                  </select>
              </label>
            )}

            {draft.kind === 'yield' && (
              <>
                <label className="block">
                  <span className="sec mb-1 block">{t('recurring.apyLabel')}</span>
                  <div className="flex items-center gap-2">
                    <input className="input flex-1 min-w-0" inputMode="decimal" value={draft.apy}
                      placeholder="5" onChange={(e) => set({ apy: e.target.value })} />
                    <span className="text-xs text-text-muted">%</span>
                  </div>
                </label>
                {yieldNeedsLots && (
                  <p className="text-[0.6875rem] text-warning">{t('recurring.yieldNeedsLots')}</p>
                )}
                <p className="text-[0.625rem] text-text-muted">{t('recurring.yieldHint')}</p>
              </>
            )}

            {draft.kind === 'buy' && (
              <>
                <Segmented
                  value={draft.buyBy}
                  options={['amount', 'quantity'] as const as ('amount' | 'quantity')[]}
                  label={(k) => t(`recurring.buyBy_${k}`)}
                  onChange={(buyBy) => set({ buyBy })}
                />
                <div className="flex gap-2">
                  <input className="input flex-1 min-w-0" inputMode="decimal" value={draft.amount}
                    placeholder={draft.buyBy === 'amount' ? t('recurring.amount') : t('recurring.quantity')}
                    onChange={(e) => set({ amount: e.target.value })} />
                  <input className="input w-20 uppercase" maxLength={3} aria-label={t('recurring.currency')} value={draft.currency}
                    onChange={(e) => set({ currency: e.target.value.toUpperCase() })} />
                </div>
                <Segmented
                  value={draft.priceMode}
                  options={['market', 'fixed'] as const as ('market' | 'fixed')[]}
                  label={(k) => t(`recurring.price_${k}`)}
                  onChange={(priceMode) => set({ priceMode })}
                />
                {draft.priceMode === 'fixed' ? (
                  <input className="input" inputMode="decimal" value={draft.price}
                    placeholder={t('recurring.pricePerUnit', { currency: draft.currency })}
                    onChange={(e) => set({ price: e.target.value })} />
                ) : (
                  <p className="text-[0.625rem] text-text-muted">{t('recurring.marketHint')}</p>
                )}
              </>
            )}

            {/* Cadence: "Every [n] [unit]", then the dates. Yield accrues daily. */}
            <div className="h-px bg-border/50" />
            {draft.kind !== 'yield' && <div className="flex items-center gap-2">
              <span className="text-xs text-text-muted">{t('recurring.everyLabel')}</span>
              <input className="input w-16 text-center" inputMode="numeric" value={draft.every}
                aria-label={t('recurring.everyLabel')} onChange={(e) => set({ every: e.target.value.replace(/\D/g, '') })} />
              <div className="flex-1">
                <Segmented
                  value={draft.unit}
                  options={UNITS}
                  label={(u) => t(`recurring.unit_${u}`, { count: Number(draft.every) || 1 })}
                  onChange={(unit) => set({ unit })}
                />
              </div>
            </div>}
            <div className="grid grid-cols-2 gap-2">
              <label className="block">
                <span className="sec mb-1 block">{t('recurring.starts')}</span>
                <input className="input w-full" type="date" value={draft.startDate} onChange={(e) => set({ startDate: e.target.value })} />
              </label>
              <label className="block">
                <span className="sec mb-1 block">{t('recurring.endsOptional')}</span>
                <input className="input w-full" type="date" value={draft.endDate} min={draft.startDate}
                  onChange={(e) => set({ endDate: e.target.value })} />
              </label>
            </div>

            {preview && (
              <div className="panel-2 px-3 py-2 text-[0.6875rem] text-text-muted flex items-center gap-2">
                <Glyph name="calendar" size={13} />
                <span>
                  {firstDue && !editingId
                    ? t('recurring.previewCatchUp', { date: formatShortDate(preview) })
                    : t('recurring.previewFirst', { date: formatShortDate(preview) })}
                </span>
              </div>
            )}
            {editingId && <p className="text-[0.625rem] text-text-muted">{t('recurring.editHint')}</p>}

            <div className="flex gap-2">
              <button className="btn flex-1" onClick={save} disabled={!ready || busy}>
                {editingId ? t('common.save') : t('common.add')}
              </button>
              <button className="btn-ghost flex-1" onClick={() => { setDraft(null); setEditingId(null); }}>
                {t('common.cancel')}
              </button>
            </div>
          </div>
        )}

        <div className="card">
          <div className="font-heading font-semibold text-sm mb-2">{t('recurring.listTitle')}</div>
          {rows.length === 0 && (
            <div className="text-xs text-text-muted text-center py-6 space-y-1">
              <div>{t('recurring.empty')}</div>
              <div className="text-[0.625rem]">{t('recurring.emptySub')}</div>
            </div>
          )}
          {rows.map(({ r, next, title, amount, sign, icon }) => (
            <div key={r.id} className="py-2.5 border-b border-border/40 last:border-0">
              <div className={`flex items-center gap-2 ${r.pausedAt ? 'opacity-60' : ''}`}>
                <span className="w-7 flex justify-center text-text-muted"><Glyph name={icon} size={15} /></span>
                <div className="flex-1 min-w-0">
                  <div className="text-sm flex items-center gap-1.5">
                    <span className="truncate">{title}</span>
                    {r.pausedAt && (
                      <span className="text-[0.5625rem] px-1.5 py-0.5 rounded-sm border border-border text-text-muted whitespace-nowrap">
                        {t('recurring.paused')}
                      </span>
                    )}
                    {!r.pausedAt && r.waitingSince && (
                      <span className="text-[0.5625rem] px-1.5 py-0.5 rounded-sm bg-warning/10 text-warning border border-warning/30 whitespace-nowrap"
                        title={t('recurring.waitingTitle', { date: formatShortDate(r.waitingSince) })}>
                        {t('recurring.waiting')}
                      </span>
                    )}
                  </div>
                  <div className="text-[0.625rem] text-text-muted">
                    {cadenceText(r)}
                    {' · '}
                    {next ? t('recurring.next', { date: formatShortDate(next) }) : r.pausedAt ? t('recurring.pausedSince', { date: formatShortDate(r.pausedAt) }) : t('recurring.ended')}
                  </div>
                </div>
                <span className={`text-xs font-heading whitespace-nowrap ${sign === '+' ? 'text-success' : 'text-text'}`}>
                  {sign}{amount}
                </span>
              </div>
              {deleting?.id === r.id ? (
                <div className="mt-2 panel-2 p-2.5 space-y-2" role="group" aria-label={t('recurring.deleteTitle')}>
                  <div className="text-xs">{t('recurring.deleteTitle')}</div>
                  {deleting.count > 0 && (
                    <div className="text-[0.625rem] text-text-muted">{t('recurring.deleteBody', { count: deleting.count })}</div>
                  )}
                  <div className="flex flex-col gap-2">
                    <button className="btn w-full" disabled={busy}
                      onClick={async () => { setBusy(true); try { await remove(r.id, { deletePast: false }); } finally { setBusy(false); setDeleting(null); } }}>
                      {deleting.count > 0 ? t('recurring.keepPast', { count: deleting.count }) : t('common.delete')}
                    </button>
                    {deleting.count > 0 && (
                      <button className="btn-ghost w-full text-danger border-danger/40" disabled={busy}
                        onClick={async () => { setBusy(true); try { await remove(r.id, { deletePast: true }); } finally { setBusy(false); setDeleting(null); } }}>
                        {t('recurring.deletePastToo')}
                      </button>
                    )}
                    <button className="btn-ghost w-full" onClick={() => setDeleting(null)}>{t('common.cancel')}</button>
                  </div>
                </div>
              ) : (
                <div className="flex gap-3 mt-1.5 ms-9 text-[0.6875rem]">
                  <button className="text-text-muted active:text-text"
                    onClick={() => { setDraft(draftOf(r, baseCurrency)); setEditingId(r.id); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>
                    {t('common.edit')}
                  </button>
                  <button className="text-text-muted active:text-text" onClick={() => void (r.pausedAt ? resume(r.id) : pause(r.id))}>
                    {r.pausedAt ? t('recurring.resume') : t('recurring.pause')}
                  </button>
                  <button className="text-danger/80 active:text-danger" onClick={() => void askDelete(r)}>
                    {t('common.delete')}
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
