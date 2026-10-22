// Purchase lots manager. One sub-screen per holding. Shows all lots in
// reverse-chronological order, lets the user add new buys, edit existing
// ones, or delete. Totals across lots are derived live (sum qty, weighted
// avg price per currency); the store keeps the holding row's cached
// aggregates in sync via recomputeHoldingAggregates() on every CRUD call.

import { useMemo, useState } from 'react';
import { currencyOptions } from '../../lib/currencies';
import { formatLocale, localDateKey } from '../../utils/formatters';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';
import AppHeader from '../../components/AppHeader';
import RowActions from '../../components/RowActions';
import { useFinanceStore } from '../../store/useFinanceStore';
import { computeSale, totalRemainingShares, saleCostBasisInCurrency } from '../../lib/stockSaleFifo';
import { convertSync } from '../../api/fxRates';
import type { PortfolioLot } from '../../types/finance';
import Glyph from '../../components/Glyph';
// v1.18.1 (NCC#144): typed amounts accept a decimal comma.
import { numberInput } from '@/lib/numberInput';



function formatNumber(n: number, max = 4): string {
  return n.toLocaleString(formatLocale(), { maximumFractionDigits: max, minimumFractionDigits: 0 });
}

export default function ManageLots() {
  const { t } = useTranslation();
  const { id: holdingId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const holding = useFinanceStore((s) => s.holdings.find((h) => h.id === holdingId));
  const allLots = useFinanceStore((s) => s.portfolioLots);
  const addLot = useFinanceStore((s) => s.addLot);
  const updateLot = useFinanceStore((s) => s.updateLot);
  const deleteLot = useFinanceStore((s) => s.deleteLot);
  const addStockSale = useFinanceStore((s) => s.addStockSale);
  const refreshPortfolio = useFinanceStore((s) => s.refreshPortfolio);
  const fxRates = useFinanceStore((s) => s.fxRates);

  const lots = useMemo(
    () =>
      allLots
        .filter((l) => l.holdingId === holdingId)
        // Most-recent purchase at top so the chronology reads naturally.
        .sort((a, b) => (b.purchaseDate ?? b.createdAt).localeCompare(a.purchaseDate ?? a.createdAt)),
    [allLots, holdingId],
  );

  // Per-currency totals for the summary card. Hoisted above the `!holding`
  // early return (HYG-2 — react-hooks/rules-of-hooks flagged this as
  // conditional when it lived further down, past the return; it only
  // depends on `lots`, so it's safe here regardless of whether `holding`
  // resolves). If the user buys in mixed currencies (e.g. some EUR, some
  // USD), we surface each separately so the math is legible instead of
  // fudging an FX conversion here. The Portfolio screen does the
  // cross-currency aggregation via fxRates.
  const totalsByCurrency = useMemo(() => {
    const map = new Map<string, { qty: number; cost: number }>();
    for (const l of lots) {
      const e = map.get(l.costCurrency) ?? { qty: 0, cost: 0 };
      e.qty += l.quantity;
      e.cost += l.quantity * l.costPerUnit;
      map.set(l.costCurrency, e);
    }
    return Array.from(map.entries()).map(([cur, v]) => ({
      currency: cur,
      qty: v.qty,
      cost: v.cost,
      avgPrice: v.qty > 0 ? v.cost / v.qty : 0,
    }));
  }, [lots]);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [qty, setQty] = useState('');
  const [price, setPrice] = useState('');
  const [currency, setCurrency] = useState('EUR');
  const [date, setDate] = useState(() => localDateKey(new Date()));
  const [notes, setNotes] = useState('');

  // v1.3.1 (BUG-23) — Record Sale form state.
  const [selling, setSelling] = useState(false);
  const [sellShares, setSellShares] = useState('');
  const [sellPrice, setSellPrice] = useState('');
  const [sellCurrency, setSellCurrency] = useState('EUR');
  const [sellDate, setSellDate] = useState(() => localDateKey(new Date()));

  if (!holding) {
    return (
      <>
        <AppHeader title={t('fin.ml.purchases')} back="/finance/portfolio/manage" backLabel={t('fin.mh.holdings')} showAvatar={false} />
        <div className="text-xs text-text-muted text-center py-6">
          {t('fin.ml.holdingNotFound')} <button className="text-primary" onClick={() => navigate('/finance/portfolio/manage')}>{t('fin.ml.goBack')}</button>.
        </div>
      </>
    );
  }

  const startAdd = () => {
    setSelling(false);
    setEditingId(null);
    setAdding(true);
    setQty('');
    setPrice('');
    // Default currency = last-used on this holding, falling back to EUR.
    setCurrency(lots[0]?.costCurrency ?? 'EUR');
    setDate(localDateKey(new Date()));
    setNotes('');
  };

  const startEdit = (lot: PortfolioLot) => {
    setSelling(false);
    setAdding(false);
    setEditingId(lot.id);
    setQty(String(lot.quantity));
    setPrice(String(lot.costPerUnit));
    setCurrency(lot.costCurrency);
    setDate(lot.purchaseDate ?? localDateKey(new Date()));
    setNotes(lot.notes ?? '');
  };

  const cancel = () => {
    setEditingId(null);
    setAdding(false);
    setSelling(false);
  };

  const save = async () => {
    const q = numberInput(qty);
    const p = numberInput(price);
    if (!q || q <= 0 || isNaN(p) || p < 0) return;
    if (editingId) {
      await updateLot(editingId, {
        quantity: q,
        costPerUnit: p,
        costCurrency: currency,
        purchaseDate: date || undefined,
        notes: notes.trim() || undefined,
      });
    } else {
      await addLot({
        holdingId: holding.id,
        quantity: q,
        costPerUnit: p,
        costCurrency: currency,
        purchaseDate: date || undefined,
        notes: notes.trim() || undefined,
      });
    }
    await refreshPortfolio();
    cancel();
  };

  const onDelete = async (lotId: string) => {
    await deleteLot(lotId);
    await refreshPortfolio();
  };

  const startSell = () => {
    setAdding(false);
    setEditingId(null);
    setSelling(true);
    setSellShares('');
    setSellPrice('');
    setSellCurrency(lots[0]?.costCurrency ?? 'EUR');
    setSellDate(localDateKey(new Date()));
  };

  const submitSale = async () => {
    const shares = numberInput(sellShares);
    const price = numberInput(sellPrice);
    if (!shares || shares <= 0 || isNaN(price) || price < 0) return;
    try {
      await addStockSale({
        holdingId: holding.id,
        ticker: holding.ticker,
        sharesSold: shares,
        salePricePerShare: price,
        currency: sellCurrency,
        soldAt: sellDate,
      });
      await refreshPortfolio();
      cancel();
    } catch (e) {
      // Oversell or other backstop failure — surface the message inline.
      alert((e as Error).message);
    }
  };

  const editingNow = adding || editingId != null;

  // v1.3.1 (BUG-23) — live FIFO preview for the sale form. Plain compute (not
  // a hook) so it sits naturally after the early return; computeSale is cheap.
  const remainingShares = totalRemainingShares(lots);
  const sellSharesNum = numberInput(sellShares);
  let salePreview: { costBasisPerShare: number; realizedGainLoss: number } | null = null;
  let saleError: string | null = null;
  if (selling && sellSharesNum > 0) {
    try {
      const c = computeSale(holding.ticker, sellSharesNum, lots);
      const priceNum = numberInput(sellPrice);
      // Cost basis converted into the sale currency so the realized figure
      // isn't a cross-currency subtraction (matches the store's commit math).
      const costTotal = saleCostBasisInCurrency(
        lots,
        c.lotAllocations,
        sellCurrency,
        (amt, from, to) => convertSync(amt, from, to, fxRates),
      );
      const costBasisPerShare = sellSharesNum > 0 ? costTotal / sellSharesNum : 0;
      const rgl = isNaN(priceNum) ? 0 : priceNum * sellSharesNum - costTotal;
      salePreview = { costBasisPerShare, realizedGainLoss: rgl };
    } catch (e) {
      saleError = (e as Error).message;
    }
  }

  return (
    <>
      <AppHeader
        title={holding.ticker.toUpperCase()}
        back="/finance/portfolio/manage"
        backLabel={t('fin.mh.holdings')}
        showAvatar={false}
        action={
          !editingNow && !selling && (
            <>
              {holding.quantity > 0 && (
                <button
                  onClick={startSell}
                  className="text-xs px-2 py-1 rounded-sm border border-border text-text-muted active:text-text active:border-border"
                >
                  {t('fin.ml.sell')}
                </button>
              )}
              {/* v1.19 — NCC#202: a recurring buy of this holding. */}
              <button
                onClick={() => navigate(`/finance/recurring?new=buy&holding=${encodeURIComponent(holding.id)}`)}
                className="text-xs px-2 py-1 rounded-sm border border-border text-text-muted active:text-text active:border-border"
                aria-label={t('recurring.addRecurring')}
                title={t('recurring.addRecurring')}
              >
                <Glyph name="refresh" size={13} />
              </button>
              <button
                onClick={startAdd}
                className="chip press-spring"
              >
                {t('fin.ml.purchase')}
              </button>
            </>
          )
        }
      />
      <div className="space-y-3">
        {/* Summary — totals across all lots, per-currency. */}
        <div className="card-elevated">
          <div className="flex items-center justify-between mb-2">
            <div>
              <div className="text-[0.625rem] uppercase tracking-[0.15em] text-text-muted">
                {holding.name}
              </div>
              <div className="font-heading font-semibold text-sm">
                <Glyph
                  name={holding.assetType === 'crypto' ? 'crypto' : holding.assetType === 'etf' ? 'etf' : 'stock'}
                  size={13}
                  className="text-text-muted"
                />{' '}{holding.ticker.toUpperCase()}
              </div>
            </div>
            <div className="text-end">
              <div className="text-[0.625rem] uppercase tracking-wider text-text-muted">{t('fin.ml.totalUnits')}</div>
              <div className="font-heading font-bold text-lg">{formatNumber(holding.quantity)}</div>
            </div>
          </div>
          {totalsByCurrency.length === 0 && (
            <div className="text-xs text-text-muted">{t('fin.ml.noPurchasesYet')}</div>
          )}
          {totalsByCurrency.map((row) => (
            <div key={row.currency} className="flex items-center justify-between text-xs py-1 border-t border-border/40 first:border-t-0 pt-1">
              <span className="text-text-muted">
                {t('fin.ml.avgCost')} <span className="text-text font-medium">
                  {formatNumber(row.avgPrice)} {row.currency}
                </span>
              </span>
              <span className="text-text-muted">
                {t('fin.ml.costBasis')} <span className="text-text font-medium">
                  {formatNumber(row.cost, 2)} {row.currency}
                </span>
              </span>
            </div>
          ))}
        </div>

        {/* Add/Edit lot form */}
        {editingNow && (
          <div className="card space-y-2">
            <div className="font-heading font-semibold text-sm">
              {editingId ? t('fin.ml.editPurchase') : t('fin.ml.newPurchase')}
            </div>
            <div className="flex gap-2">
              <input
                className="input flex-1"
                placeholder={t('fin.ml.quantity')}
                inputMode="decimal"
                value={qty}
                onChange={(e) => setQty(e.target.value)}
                autoFocus
              />
              <input
                className="input flex-1"
                placeholder={t('fin.ml.pricePerUnit')}
                inputMode="decimal"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
              />
              <select
                className="input max-w-[88px]"
                value={currency}
                onChange={(e) => setCurrency(e.target.value)}
              >
                {currencyOptions(formatLocale()).map((c) => (
                  <option key={c.code} value={c.code}>{c.label}</option>
                ))}
              </select>
            </div>
            <input
              className="input"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
            <input
              className="input"
              placeholder={t('fin.ml.notesPh')}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
            <div className="flex gap-2">
              <button className="btn flex-1" onClick={save}>
                {editingId ? t('common.save') : t('fin.ml.addPurchase')}
              </button>
              <button className="btn-ghost flex-1" onClick={cancel}>
                {t('common.cancel')}
              </button>
            </div>
            <div className="text-[0.625rem] text-text-muted">
              {t('fin.ml.costHint')}
            </div>
          </div>
        )}

        {/* Record Sale form (v1.3.1 BUG-23) — FIFO cost basis over oldest lots */}
        {selling && (
          <div className="card space-y-2">
            <div className="font-heading font-semibold text-sm">{t('fin.ml.recordSale')}</div>
            <div className="text-[0.625rem] text-text-muted">
              {t('fin.ml.unitsAvailable', { units: formatNumber(remainingShares) })}
            </div>
            <div className="flex gap-2">
              <input
                className="input flex-1"
                placeholder={t('fin.ml.sharesToSell')}
                inputMode="decimal"
                value={sellShares}
                onChange={(e) => setSellShares(e.target.value)}
                autoFocus
              />
              <input
                className="input flex-1"
                placeholder={t('fin.ml.salePrice')}
                inputMode="decimal"
                value={sellPrice}
                onChange={(e) => setSellPrice(e.target.value)}
              />
              <select
                className="input max-w-[88px]"
                value={sellCurrency}
                onChange={(e) => setSellCurrency(e.target.value)}
              >
                {currencyOptions(formatLocale()).map((c) => (
                  <option key={c.code} value={c.code}>{c.label}</option>
                ))}
              </select>
            </div>
            <input
              className="input"
              type="date"
              value={sellDate}
              onChange={(e) => setSellDate(e.target.value)}
            />
            {saleError && <div className="text-[0.6875rem] text-danger">{saleError}</div>}
            {salePreview && (
              <div className="text-xs rounded-sm border border-border/60 bg-surface2/30 px-2.5 py-2 space-y-0.5">
                <div className="flex justify-between">
                  <span className="text-text-muted">{t('fin.ml.costBasisFifo')}</span>
                  <span className="font-medium">
                    {t('fin.ml.perUnit', { amount: formatNumber(salePreview.costBasisPerShare), cur: sellCurrency })}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-text-muted">
                    {salePreview.realizedGainLoss >= 0 ? t('fin.ml.realizedGain') : t('fin.ml.realizedLoss')}
                  </span>
                  <span className={`font-semibold ${salePreview.realizedGainLoss >= 0 ? 'text-success' : 'text-danger'}`}>
                    {salePreview.realizedGainLoss >= 0 ? '+' : '−'}
                    {formatNumber(Math.abs(salePreview.realizedGainLoss), 2)} {sellCurrency}
                  </span>
                </div>
              </div>
            )}
            <div className="flex gap-2">
              <button className="btn flex-1" onClick={submitSale} disabled={!salePreview}>
                {t('fin.ml.recordSale')}
              </button>
              <button className="btn-ghost flex-1" onClick={cancel}>{t('common.cancel')}</button>
            </div>
          </div>
        )}

        {/* Lots list */}
        <div className="card">
          <div className="font-heading font-semibold text-sm mb-2">{t('fin.ml.purchaseHistory')}</div>
          {lots.length === 0 && (
            <div className="text-xs text-text-muted text-center py-4">
              {t('fin.ml.noPurchases')}
            </div>
          )}
          {lots.map((lot) => (
            <div key={lot.id} className="flex items-center gap-2 py-2 border-b border-border/40 last:border-0">
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium">
                  {t('fin.ml.unitsAt', { qty: formatNumber(lot.quantity), price: formatNumber(lot.costPerUnit), cur: lot.costCurrency })}
                </div>
                <div className="text-[0.625rem] text-text-muted">
                  {lot.purchaseDate ?? lot.createdAt.slice(0, 10)}
                  {' · '}{t('fin.ml.totalCost', { amount: formatNumber(lot.quantity * lot.costPerUnit, 2), cur: lot.costCurrency })}
                  {lot.notes && <> · {lot.notes}</>}
                </div>
              </div>
              <RowActions
                onEdit={() => startEdit(lot)}
                onDelete={() => onDelete(lot.id)}
                confirmMsg={t('fin.ml.deletePurchase')}
              />
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
