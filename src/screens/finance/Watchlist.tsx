// Tickers tracked without owning. Reuses the existing quote pipeline (added
// to refreshPortfolio's equity/crypto batches via the store), so each row
// shows live current price + day change + a sparkline.
//
// Tapping a row opens the same HoldingDetailSheet used on the Portfolio
// screen — fundamentals, news, etc. We synthesize a transient
// PortfolioHolding shape for the detail-sheet contract (quantity = 0,
// no lots) since the sheet only reads ticker/name/assetType for its identity
// row and pulls live data via fetchHoldingDetail() based on ticker.

import { useEffect, useMemo, useState } from 'react';
import { formatMoney } from '../../lib/currencies';
import { formatLocale } from '../../utils/formatters';
import { useTranslation } from 'react-i18next';
import AppHeader from '../../components/AppHeader';
import RowActions from '../../components/RowActions';
import SparkLine from '../../components/SparkLine';
import HoldingDetailSheet from '../../components/HoldingDetailSheet';
import RatingPill from '../../components/RatingPill';
import { useFinanceStore } from '../../store/useFinanceStore';
import { useSettingsStore } from '../../store/useSettingsStore';
import { resolveWatchPrice, targetHit } from '../../lib/watchlistAlerts';
import { validateTicker } from '../../lib/tickerValidation';
import { useShellTier } from '../../lib/useShell';
import type { WatchlistItem, PortfolioHolding } from '../../types/finance';
// v1.18.1 (NCC#144): typed amounts accept a decimal comma.
import { numberInput } from '@/lib/numberInput';

function fmt(amount: number, currency: string): string {
  return formatMoney(amount, currency, { locale: formatLocale() });
}

export default function Watchlist() {
  const { t } = useTranslation();
  const watchlist = useFinanceStore((s) => s.watchlist);
  const stockQuotes = useFinanceStore((s) => s.stockQuotes);
  const cryptoPrices = useFinanceStore((s) => s.cryptoPrices);
  const sparklines = useFinanceStore((s) => s.sparklines);
  const fxRates = useFinanceStore((s) => s.fxRates);
  const refreshPortfolio = useFinanceStore((s) => s.refreshPortfolio);
  const refreshing = useFinanceStore((s) => s.refreshing);
  const addItem = useFinanceStore((s) => s.addWatchlistItem);
  const updateItem = useFinanceStore((s) => s.updateWatchlistItem);
  const deleteItem = useFinanceStore((s) => s.deleteWatchlistItem);
  const baseCurrency = useSettingsStore((s) => s.baseCurrency);

  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<WatchlistItem | null>(null);
  const [ticker, setTicker] = useState('');
  const [name, setName] = useState('');
  // v1.2.1 — security audit finding M: ticker entry-point allowlist.
  // Surfaces validation errors inline so the user understands why the
  // save button looks armed but does nothing.
  const [tickerError, setTickerError] = useState<string | null>(null);
  const [assetType, setAssetType] = useState<WatchlistItem['assetType']>('stock');
  const [targetAbove, setTargetAbove] = useState('');
  const [targetBelow, setTargetBelow] = useState('');
  // v1.9 Item 14b #7 — one selection, two presentations. On a phone the
  // selection opens a bottom sheet, which is the right gesture there. On
  // desktop it drives a permanently-visible right pane, because the whole
  // point of the width is that you can compare the list against the detail
  // without navigating away.
  const isDesktop = useShellTier() === 'desktop';
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const startAdd = () => {
    setAdding(true);
    setEditing(null);
    setTicker('');
    setName('');
    setAssetType('stock');
    setTargetAbove('');
    setTargetBelow('');
  };

  const startEdit = (w: WatchlistItem) => {
    setEditing(w);
    setAdding(false);
    setTicker(w.ticker);
    setName(w.name);
    setAssetType(w.assetType);
    setTargetAbove(w.targetAbove != null ? String(w.targetAbove) : '');
    setTargetBelow(w.targetBelow != null ? String(w.targetBelow) : '');
  };

  const cancel = () => {
    setAdding(false);
    setEditing(null);
  };

  const save = async () => {
    if (!name.trim()) return;
    // v1.2.1 — security audit finding M. Validate before any store write
    // so a hostile / typo'd identifier never makes it into Dexie, the
    // outbox, or any URL we build downstream. encodeURIComponent at the
    // URL site is still the structural guarantee; this is defense in depth.
    const v = validateTicker(ticker);
    if (!v.ok) {
      setTickerError(v.error);
      return;
    }
    setTickerError(null);
    const above = targetAbove.trim() ? numberInput(targetAbove) : undefined;
    const below = targetBelow.trim() ? numberInput(targetBelow) : undefined;
    if (editing) {
      await updateItem(editing.id, {
        ticker: v.normalised,
        name: name.trim(),
        assetType,
        targetAbove: above,
        targetBelow: below,
      });
    } else {
      await addItem({
        ticker: v.normalised,
        name: name.trim(),
        assetType,
        targetAbove: above,
        targetBelow: below,
      });
    }
    await refreshPortfolio();
    cancel();
  };

  // Rows with quote-derived display data.
  const rows = useMemo(() => {
    return watchlist.map((w) => {
      // v1.15 Item 9 — price and target check moved to watchlistAlerts.ts so
      // this badge and the notification read the same numbers.
      const { price, currency, dayPct } = resolveWatchPrice(w, stockQuotes, cryptoPrices, fxRates, baseCurrency);
      const sparkline: number[] | undefined =
        sparklines[w.assetType === 'crypto' ? w.ticker.toLowerCase() : w.ticker.toUpperCase()];
      const alert = targetHit(w, price);
      return { item: w, price, currency, dayPct, sparkline, alert };
    });
  }, [watchlist, stockQuotes, cryptoPrices, sparklines, fxRates, baseCurrency]);

  const editingNow = adding || editing != null;

  // HoldingDetailSheet wants a PortfolioHolding. quantity 0 is honest here —
  // a watched ticker is explicitly one we do NOT own — and the sheet reads
  // only ticker/name/assetType for identity, fetching everything else live.
  const selectedHolding: PortfolioHolding | null = useMemo(() => {
    const w = watchlist.find((x) => x.id === selectedId);
    if (!w) return null;
    return {
      id: w.id,
      ticker: w.ticker,
      name: w.name,
      assetType: w.assetType,
      quantity: 0,
      createdAt: w.createdAt,
    };
  }, [watchlist, selectedId]);

  // Desktop keeps a row selected so the pane is never an empty column on
  // arrival, and re-points if the selected ticker is deleted out from under it.
  useEffect(() => {
    if (!isDesktop) return;
    if (selectedId && watchlist.some((w) => w.id === selectedId)) return;
    // HYG-4: Selection is user-driven; the guards above mean this only re-points when
    // the selected ticker has been deleted out from under the pane.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSelectedId(watchlist[0]?.id ?? null);
  }, [isDesktop, watchlist, selectedId]);

  return (
    <>
      <AppHeader
        title={t('fin.ov.watchlist')}
        back="/finance/portfolio"
        backLabel={t('fin.ov.portfolio')}
        showAvatar={false}
        action={
          !editingNow && (
            <>
              <button
                onClick={() => refreshPortfolio()}
                className="text-xs px-2 py-1 rounded-sm border border-border text-text-muted active:text-text active:border-border"
                disabled={refreshing}
              >
                {refreshing ? '…' : '↻'}
              </button>
              <button
                onClick={startAdd}
                className="chip press-spring"
              >
                {t('fin.wl.add')}
              </button>
            </>
          )
        }
      />
      {/* Two panes above 1200px, one column below. `items-start` so the
          detail pane does not stretch to the list's height when the list is
          long, and the list keeps its own scroll. */}
      <div
        className={
          isDesktop
            ? 'grid grid-cols-[minmax(340px,440px)_1fr] gap-3 items-start'
            : 'space-y-3'
        }
      >
        <div className="space-y-3">
        {editingNow && (
          <div className="card space-y-2">
            <div className="font-heading font-semibold text-sm">
              {editing ? t('fin.wl.editWatch') : t('fin.wl.newWatch')}
            </div>
            <div className="flex gap-2">
              {(['stock', 'etf', 'crypto'] as const).map((ty) => (
                <button
                  key={ty}
                  type="button"
                  onClick={() => setAssetType(ty)}
                  className={`chip flex-1 ${assetType === ty ? 'chip-on' : ''}`}
                >
                  {t(`fin.assetClass.${ty}`)}
                </button>
              ))}
            </div>
            <input
              className="input"
              placeholder={
                assetType === 'crypto' ? t('fin.wl.cgIdPh') : t('fin.wl.tickerPh')
              }
              value={ticker}
              onChange={(e) => {
                setTicker(e.target.value);
                if (tickerError) setTickerError(null);
              }}
              autoFocus
              autoCapitalize="off"
              autoCorrect="off"
            />
            {tickerError && (
              <div className="text-[0.6875rem] text-warning">{tickerError}</div>
            )}
            <input
              className="input"
              placeholder={t('fin.wl.displayName')}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <div className="text-[0.625rem] uppercase tracking-wider text-text-muted mt-2">
              {t('fin.wl.alerts')}
            </div>
            <div className="flex gap-2">
              <input
                className="input flex-1"
                placeholder={t('fin.wl.alertAbove')}
                inputMode="decimal"
                value={targetAbove}
                onChange={(e) => setTargetAbove(e.target.value)}
              />
              <input
                className="input flex-1"
                placeholder={t('fin.wl.alertBelow')}
                inputMode="decimal"
                value={targetBelow}
                onChange={(e) => setTargetBelow(e.target.value)}
              />
            </div>
            <div className="flex gap-2">
              <button className="btn flex-1" onClick={save}>
                {editing ? t('common.save') : t('common.add')}
              </button>
              <button className="btn-ghost flex-1" onClick={cancel}>
                {t('common.cancel')}
              </button>
            </div>
            <div className="text-[0.625rem] text-text-muted">
              {t('fin.wl.helper')}
            </div>
          </div>
        )}

        <div className="card">
          <div className="flex items-center justify-between mb-3">
            <span className="font-heading font-semibold text-sm">{t('fin.wl.watching')}</span>
            <span className="text-[0.5625rem] uppercase tracking-wider text-text-muted">
              {t('fin.wl.tickers', { count: rows.length })}
            </span>
          </div>
          {rows.length === 0 && !editingNow && (
            <div className="text-xs text-text-muted text-center py-6">
              {t('fin.wl.empty')}
            </div>
          )}
          {rows.map((r) => (
            <div
              key={r.item.id}
              className={`flex items-center gap-2 py-2 border-b border-border/40 last:border-0 ${
                // Cyan edge-rail for the active row — the same active-state
                // language SideNav uses, so selection reads as one system.
                isDesktop && selectedId === r.item.id
                  ? 'border-s-2 border-s-primary bg-primary/[0.06] -ms-2 ps-2'
                  : isDesktop
                    ? 'border-s-2 border-s-transparent -ms-2 ps-2'
                    : ''
              }`}
            >
              <button
                onClick={() => setSelectedId(r.item.id)}
                aria-current={isDesktop && selectedId === r.item.id ? 'true' : undefined}
                className="flex-1 flex items-center gap-2 min-w-0 text-start"
              >
                <div className="flex flex-col w-[68px] min-w-0">
                  <span className="text-sm font-medium truncate">{r.item.ticker.toUpperCase()}</span>
                  <span className="text-[0.5625rem] uppercase tracking-wider text-text-muted truncate">
                    {t(`fin.assetAbbr.${r.item.assetType}`, { defaultValue: r.item.assetType.toUpperCase() })}
                  </span>
                  {/* v1.2 — Insights tier pill. Stock + ETF only (crypto/fx
                      out of scope for the signal engine today). */}
                  {(r.item.assetType === 'stock' || r.item.assetType === 'etf') && (
                    <span className="mt-1">
                      <RatingPill ticker={r.item.ticker} compact />
                    </span>
                  )}
                </div>
                <div className="flex-1 min-w-0 px-1">
                  {r.sparkline && r.sparkline.length >= 2 ? (
                    <SparkLine data={r.sparkline} height={24} trend={r.dayPct >= 0 ? 'up' : 'down'} />
                  ) : (
                    <div className="h-6" />
                  )}
                </div>
                <div className="flex flex-col items-end">
                  <span className="text-sm whitespace-nowrap">
                    {r.price != null ? fmt(r.price, r.currency) : '—'}
                  </span>
                  <span className={`text-[0.625rem] whitespace-nowrap ${r.dayPct >= 0 ? 'text-success' : 'text-danger'}`}>
                    {r.dayPct >= 0 ? '↑' : '↓'} {Math.abs(r.dayPct).toFixed(2)}%
                  </span>
                  {r.alert && (
                    <span className={`text-[0.5625rem] uppercase tracking-wider px-1 py-0.5 rounded-sm border mt-0.5 ${
                      r.alert === 'above'
                        ? 'border-success/40 bg-success/10 text-success'
                        : 'border-warning/40 bg-warning/10 text-warning'
                    }`}>
                      {r.alert === 'above' ? t('fin.wl.targetAboveHit') : t('fin.wl.targetBelowHit')}
                    </span>
                  )}
                </div>
              </button>
              <RowActions
                onEdit={() => startEdit(r.item)}
                onDelete={() => deleteItem(r.item.id)}
                confirmMsg={t('fin.wl.stopWatching', { ticker: r.item.ticker.toUpperCase() })}
              />
            </div>
          ))}
        </div>
        </div>

        {isDesktop && (
          // `sticky` so the detail stays put while a long watchlist scrolls
          // past it — the pane is a reading surface, not a second list.
          <div className="card sticky top-3">
            {selectedHolding ? (
              <HoldingDetailSheet holding={selectedHolding} onClose={() => {}} inline />
            ) : (
              <div className="text-xs text-text-muted text-center py-10">
                {rows.length === 0 ? t('fin.wl.empty') : t('fin.wl.pickOne')}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Phone and tablet keep the sheet. Rendering both would mount the same
          live-data component twice and double every detail fetch. */}
      {!isDesktop && (
        <HoldingDetailSheet holding={selectedHolding} onClose={() => setSelectedId(null)} />
      )}
    </>
  );
}
