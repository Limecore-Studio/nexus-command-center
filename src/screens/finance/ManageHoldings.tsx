import { useState } from 'react';
import { formatLocale, localDateKey } from '../../utils/formatters';
import { currencyOptions } from '../../lib/currencies';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import AppHeader from '../../components/AppHeader';
import RowActions from '../../components/RowActions';
import { useFinanceStore } from '../../store/useFinanceStore';
import { validateTicker } from '../../lib/tickerValidation';
import { isHoldingClosed } from '../../lib/positionStatus';
import type { PortfolioHolding, AssetType, BondTerms } from '../../types/finance';
import { isManuallyPriced } from '../../types/finance';
import Glyph from '../../components/Glyph';
// v1.18.1 (NCC#144): typed amounts accept a decimal comma.
import { numberInput } from '@/lib/numberInput';



// Add flow asks for the FIRST purchase inline so a single tap creates both
// the holding and its initial lot. Editing an existing holding never touches
// lots — that's what the Purchases sub-screen is for. This split is important:
// editing the ticker shouldn't accidentally erase your purchase history.
export default function ManageHoldings() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const holdings = useFinanceStore((s) => s.holdings);
  const portfolioLots = useFinanceStore((s) => s.portfolioLots);
  const addHolding = useFinanceStore((s) => s.addHolding);
  const updateHolding = useFinanceStore((s) => s.updateHolding);
  const deleteHolding = useFinanceStore((s) => s.deleteHolding);
  const addLot = useFinanceStore((s) => s.addLot);
  const refreshPortfolio = useFinanceStore((s) => s.refreshPortfolio);

  const [editing, setEditing] = useState<PortfolioHolding | null>(null);
  const [adding, setAdding] = useState(false);
  const [ticker, setTicker] = useState('');
  const [name, setName] = useState('');
  // v1.2.1 — security audit finding M: ticker entry-point allowlist.
  // Surfaces validation errors inline so the user understands why save
  // looks armed but does nothing.
  const [tickerError, setTickerError] = useState<string | null>(null);
  const [assetType, setAssetType] = useState<AssetType>('stock');
  const [sectorOverride, setSectorOverride] = useState('');
  const [showClosed, setShowClosed] = useState(false);

  // First-purchase fields (Add flow only).
  const [firstQty, setFirstQty] = useState('');
  const [firstPrice, setFirstPrice] = useState('');
  const [firstCurrency, setFirstCurrency] = useState('EUR');
  const [firstDate, setFirstDate] = useState(() => localDateKey(new Date()));

  // v1.19 (NCC#204): a bond's terms, and the price the user enters (a custom
  // holding's price, or a bond's market price that overrides its book value).
  const [faceValue, setFaceValue] = useState('100');
  const [bondCurrency, setBondCurrency] = useState('EUR');
  const [couponRate, setCouponRate] = useState('');
  const [couponFreq, setCouponFreq] = useState<BondTerms['couponFrequency']>(1);
  const [maturity, setMaturity] = useState('');
  const [isin, setIsin] = useState('');
  const [manualPrice, setManualPrice] = useState('');
  const [manualCurrency, setManualCurrency] = useState('EUR');

  const lotsByHolding = (id: string) => portfolioLots.filter((l) => l.holdingId === id);

  // Fully-sold positions (e.g. a stock you bought then entirely closed) move
  // into a collapsed "Closed" section so the live list stays focused on what
  // you still hold — but they remain reachable to view purchase history or
  // remove. Same definition as Portfolio + the dividend projection.
  const openH = holdings.filter((h) => !isHoldingClosed(h, portfolioLots));
  const closedH = holdings.filter((h) => isHoldingClosed(h, portfolioLots));

  const startAdd = () => {
    setEditing(null);
    setAdding(true);
    setTicker('');
    setName('');
    setAssetType('stock');
    setSectorOverride('');
    setFirstQty('');
    setFirstPrice('');
    setFirstCurrency('EUR');
    setFirstDate(localDateKey(new Date()));
    setFaceValue('100');
    setBondCurrency('EUR');
    setCouponRate('');
    setCouponFreq(1);
    setMaturity('');
    setIsin('');
    setManualPrice('');
    setManualCurrency('EUR');
  };

  const startEdit = (h: PortfolioHolding) => {
    setAdding(false);
    setEditing(h);
    setTicker(h.ticker);
    setName(h.name);
    setAssetType(h.assetType);
    setSectorOverride(h.sectorOverride ?? '');
    setFaceValue(h.bond ? String(h.bond.faceValue) : '100');
    setBondCurrency(h.bond?.currency ?? 'EUR');
    setCouponRate(h.bond ? String(h.bond.couponRate) : '');
    setCouponFreq(h.bond?.couponFrequency ?? 1);
    setMaturity(h.bond?.maturity ?? '');
    setIsin(h.bond?.isin ?? '');
    setManualPrice(h.manualPrice != null ? String(h.manualPrice) : '');
    setManualCurrency(h.manualPriceCurrency ?? h.bond?.currency ?? 'EUR');
  };

  /** v1.19 (NCC#204): the bond / custom fields, or null while incomplete. */
  const manualFields = (): Partial<PortfolioHolding> | null => {
    if (!isManuallyPriced(assetType)) {
      return { bond: undefined, manualPrice: undefined, manualPriceCurrency: undefined, manualPriceAt: undefined };
    }
    const price = manualPrice.trim() ? numberInput(manualPrice) : undefined;
    if (price !== undefined && !(price >= 0)) return null;
    const priceChanged = price !== editing?.manualPrice || manualCurrency !== editing?.manualPriceCurrency;
    const priceFields = {
      manualPrice: price,
      manualPriceCurrency: price !== undefined ? manualCurrency : undefined,
      manualPriceAt: price === undefined ? undefined : priceChanged ? new Date().toISOString() : editing?.manualPriceAt,
    };
    if (assetType === 'custom') {
      if (price === undefined) return null; // a custom holding is its price
      return { ...priceFields, bond: undefined };
    }
    const face = numberInput(faceValue);
    const rate = couponRate.trim() ? numberInput(couponRate) : 0;
    if (!(face > 0) || !(rate >= 0) || rate > 100 || !maturity) return null;
    return {
      ...priceFields,
      bond: { faceValue: face, currency: bondCurrency, couponRate: rate, couponFrequency: rate > 0 ? couponFreq : 0, maturity, isin: isin.trim() || undefined },
    };
  };

  const cancel = () => {
    setEditing(null);
    setAdding(false);
  };

  const save = async () => {
    if (!name.trim()) return;
    // v1.2.1 — security audit finding M. Validate before any store write
    // so a hostile / typo'd identifier never makes it into Dexie, the
    // outbox, or any URL we build downstream.
    const v = validateTicker(ticker);
    if (!v.ok) {
      setTickerError(v.error);
      return;
    }
    setTickerError(null);
    const extra = manualFields();
    if (!extra) return;
    const normalisedTicker = assetType === 'crypto'
      ? v.normalised.toLowerCase()
      : v.normalised.toUpperCase();
    if (editing) {
      // Edit flow — basic details only. Quantity + cost are derived from lots
      // and aren't editable here.
      await updateHolding(editing.id, {
        ticker: normalisedTicker,
        name: name.trim(),
        assetType,
        sectorOverride: sectorOverride.trim() || undefined,
        ...extra,
      });
    } else {
      // Add flow — must have at least quantity + price for the first lot
      // (otherwise creating an empty holding with no purchase history is
      // worse than telling the user up-front).
      const qty = numberInput(firstQty);
      const price = numberInput(firstPrice);
      if (!qty || qty <= 0 || isNaN(price) || price < 0) return;
      const holdingId = await addHolding({
        ticker: normalisedTicker,
        name: name.trim(),
        assetType,
        quantity: qty, // initial value; lot creation will overwrite via recompute
        sectorOverride: sectorOverride.trim() || undefined,
        ...extra,
      });
      await addLot({
        holdingId,
        quantity: qty,
        costPerUnit: price,
        costCurrency: firstCurrency,
        purchaseDate: firstDate || undefined,
      });
    }
    await refreshPortfolio();
    // v1.19 (NCC#204): a bond's coupons (and a past maturity) are written by
    // the recurring engine; run it now so they show without a restart.
    if (assetType === 'bond') {
      void import('../../store/useRecurringStore').then((m) => m.useRecurringStore.getState().materialize());
    }
    cancel();
  };

  const onDelete = async (id: string) => {
    await deleteHolding(id);
    await refreshPortfolio();
  };

  const editingNow = adding || editing != null;

  const renderHoldingRow = (h: PortfolioHolding, closed = false) => {
    const lotCount = lotsByHolding(h.id).length;
    return (
      <div
        key={h.id}
        className={`flex items-center gap-2 py-2 border-b border-border/40 last:border-0 ${closed ? 'opacity-60' : ''}`}
      >
        <span className="text-[0.5625rem] uppercase text-text-muted w-10 flex-shrink-0">
          {t(`fin.assetAbbr.${h.assetType}`)}
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-heading font-semibold truncate">
            {h.ticker.toUpperCase()}
            {closed && <span className="ms-1.5 text-[0.5rem] uppercase tracking-wider text-text-muted">{t('fin.mh.closed')}</span>}
          </div>
          <div className="text-[0.625rem] text-text-muted truncate">
            {h.name} · {h.quantity}
            {h.sectorOverride && <> · {h.sectorOverride}</>}
          </div>
        </div>
        <button
          onClick={() => navigate(`/finance/portfolio/lots/${h.id}`)}
          className="text-[0.625rem] uppercase tracking-wider px-1.5 py-0.5 rounded-sm border border-border text-text-muted active:border-border active:text-text flex-shrink-0"
        >
          <Glyph name="lots" size={11} className="inline-block align-[-1px] me-1" />{lotCount}
        </button>
        <RowActions
          onEdit={() => startEdit(h)}
          onDelete={() => onDelete(h.id)}
          confirmMsg={t('fin.mh.removeConfirm', { ticker: h.ticker.toUpperCase() })}
        />
      </div>
    );
  };

  return (
    <>
      <AppHeader
        title={t('fin.mh.title')}
        back="/finance/portfolio"
        backLabel={t('fin.ov.portfolio')}
        showAvatar={false}
        action={
          !editingNow && (
            <button
              onClick={startAdd}
              className="chip press-spring"
            >
              {t('fin.mh.new')}
            </button>
          )
        }
      />
      <div className="space-y-3">
        {editingNow && (
          <div className="card space-y-2">
            <div className="font-heading font-semibold text-sm">
              {editing ? t('fin.mh.editHolding') : t('fin.mh.newHolding')}
            </div>
            <div className="grid grid-cols-5 gap-1.5">
              {(['stock', 'etf', 'crypto', 'bond', 'custom'] as AssetType[]).map((ty) => (
                <button
                  key={ty}
                  onClick={() => {
                    setAssetType(ty);
                    if (ty === 'bond' && !editing) setFirstPrice((p) => p || faceValue);
                  }}
                  className={`chip justify-center px-1 ${assetType === ty ? 'chip-on' : ''}`}
                  type="button"
                >
                  {t(`fin.assetClass.${ty}`)}
                </button>
              ))}
            </div>
            <input
              className="input"
              placeholder={
                assetType === 'crypto'
                  ? t('fin.mh.cgIdPh')
                  : isManuallyPriced(assetType)
                    ? t('bonds.labelPh')
                    : assetType === 'etf'
                    ? t('fin.mh.etfTickerPh')
                    : t('fin.mh.stockTickerPh')
              }
              value={ticker}
              onChange={(e) => {
                setTicker(e.target.value);
                if (tickerError) setTickerError(null);
              }}
              autoFocus
            />
            {tickerError && (
              <div className="text-[0.6875rem] text-warning">{tickerError}</div>
            )}
            <input
              className="input"
              placeholder={t('fin.mh.displayName')}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <input
              className="input"
              placeholder={t('fin.mh.sectorPh')}
              value={sectorOverride}
              onChange={(e) => setSectorOverride(e.target.value)}
            />
            {/* v1.19 (NCC#204): a bond's terms. */}
            {assetType === 'bond' && (
              <div className="panel-2 p-2.5 space-y-2">
                <div className="text-[0.625rem] uppercase tracking-wider text-text-muted">{t('bonds.terms')}</div>
                <div className="flex gap-2">
                  <label className="flex-1 min-w-0">
                    <span className="text-[0.625rem] text-text-muted block mb-0.5">{t('bonds.faceValue')}</span>
                    <input className="input w-full" inputMode="decimal" value={faceValue} onChange={(e) => setFaceValue(e.target.value)} />
                  </label>
                  <label className="w-[96px]">
                    <span className="text-[0.625rem] text-text-muted block mb-0.5">{t('bonds.currency')}</span>
                    <select className="input w-full" value={bondCurrency}
                      onChange={(e) => { setBondCurrency(e.target.value); setFirstCurrency(e.target.value); setManualCurrency(e.target.value); }}>
                      {currencyOptions(formatLocale()).map((c) => (
                        <option key={c.code} value={c.code}>{c.label}</option>
                      ))}
                    </select>
                  </label>
                </div>
                <div className="flex gap-2">
                  <label className="flex-1 min-w-0">
                    <span className="text-[0.625rem] text-text-muted block mb-0.5">{t('bonds.couponRate')}</span>
                    <input className="input w-full" inputMode="decimal" placeholder="0" value={couponRate} onChange={(e) => setCouponRate(e.target.value)} />
                  </label>
                  <label className="flex-1 min-w-0">
                    <span className="text-[0.625rem] text-text-muted block mb-0.5">{t('bonds.frequency')}</span>
                    <select className="input w-full" value={couponFreq}
                      onChange={(e) => setCouponFreq(Number(e.target.value) as BondTerms['couponFrequency'])}>
                      {([1, 2, 4] as const).map((n) => (
                        <option key={n} value={n}>{t(`bonds.freq_${n}`)}</option>
                      ))}
                    </select>
                  </label>
                </div>
                <div className="flex gap-2">
                  <label className="flex-1 min-w-0">
                    <span className="text-[0.625rem] text-text-muted block mb-0.5">{t('bonds.maturity')}</span>
                    <input className="input w-full" type="date" value={maturity} onChange={(e) => setMaturity(e.target.value)} />
                  </label>
                  <label className="flex-1 min-w-0">
                    <span className="text-[0.625rem] text-text-muted block mb-0.5">{t('bonds.isinOptional')}</span>
                    <input className="input w-full uppercase" maxLength={12} value={isin} onChange={(e) => setIsin(e.target.value.toUpperCase())} />
                  </label>
                </div>
                <div className="text-[0.625rem] text-text-muted">{t('bonds.bookHint')}</div>
              </div>
            )}
            {/* v1.19 (NCC#204): the price the user enters. Required for a
                custom holding; for a bond it replaces the book value. */}
            {isManuallyPriced(assetType) && (
              <div className="space-y-1">
                <div className="flex gap-2">
                  <input className="input flex-1 min-w-0" inputMode="decimal" value={manualPrice}
                    placeholder={assetType === 'bond' ? t('bonds.marketPriceOptional') : t('bonds.pricePerUnit')}
                    onChange={(e) => setManualPrice(e.target.value)} />
                  <select className="input max-w-[88px]" value={manualCurrency} onChange={(e) => setManualCurrency(e.target.value)}>
                    {currencyOptions(formatLocale()).map((c) => (
                      <option key={c.code} value={c.code}>{c.label}</option>
                    ))}
                  </select>
                </div>
                {assetType === 'bond' && manualPrice.trim() !== '' && (
                  <button type="button" className="text-[0.6875rem] text-text-muted active:text-text" onClick={() => setManualPrice('')}>
                    {t('bonds.useBookValue')}
                  </button>
                )}
              </div>
            )}
            {!editing && (
              <>
                <div className="text-[0.625rem] uppercase tracking-wider text-text-muted mt-1">
                  {t('fin.mh.firstPurchase')}
                </div>
                <div className="flex gap-2">
                  <input
                    className="input flex-1"
                    placeholder={t('fin.mh.quantity')}
                    inputMode="decimal"
                    value={firstQty}
                    onChange={(e) => setFirstQty(e.target.value)}
                  />
                  <input
                    className="input flex-1"
                    placeholder={t('fin.mh.pricePerUnit')}
                    inputMode="decimal"
                    value={firstPrice}
                    onChange={(e) => setFirstPrice(e.target.value)}
                  />
                  <select
                    className="input max-w-[88px]"
                    value={firstCurrency}
                    onChange={(e) => setFirstCurrency(e.target.value)}
                  >
                    {currencyOptions(formatLocale()).map((c) => (
                      <option key={c.code} value={c.code}>{c.label}</option>
                    ))}
                  </select>
                </div>
                <input
                  className="input"
                  type="date"
                  value={firstDate}
                  onChange={(e) => setFirstDate(e.target.value)}
                />
              </>
            )}
            <div className="flex gap-2">
              <button className="btn flex-1" onClick={save}>
                {editing ? t('common.save') : t('common.add')}
              </button>
              <button className="btn-ghost flex-1" onClick={cancel}>
                {t('common.cancel')}
              </button>
            </div>
            <div className="text-[0.625rem] text-text-muted">
              {assetType === 'stock'
                ? t('fin.mh.stockHint')
                : assetType === 'etf'
                  ? t('fin.mh.etfHint')
                  : assetType === 'bond'
                    ? t('bonds.bondHint')
                    : assetType === 'custom'
                      ? t('bonds.customHint')
                      : t('fin.mh.cryptoHint')}
              {t('fin.mh.addLater')}
            </div>
          </div>
        )}

        <div className="card">
          <div className="font-heading font-semibold text-sm mb-2">{t('fin.mh.holdings')}</div>
          {holdings.length === 0 && (
            <div className="text-xs text-text-muted text-center py-4">
              {t('fin.mh.empty')}
            </div>
          )}
          {holdings.length > 0 && openH.length === 0 && (
            <div className="text-xs text-text-muted text-center py-4">
              {t('fin.mh.noOpen')}
            </div>
          )}
          {openH.map((h) => renderHoldingRow(h))}
        </div>

        {closedH.length > 0 && (
          <div className="card">
            <button
              onClick={() => setShowClosed((s) => !s)}
              className="w-full flex items-center justify-between text-sm font-heading font-semibold"
            >
              <span className="text-text-muted">{t('fin.mh.closedPositions')}</span>
              <span className="text-[0.625rem] uppercase tracking-wider text-text-muted">
                {closedH.length} · {showClosed ? '▲' : '▼'}
              </span>
            </button>
            {showClosed && (
              <div className="mt-2">
                {closedH.map((h) => renderHoldingRow(h, true))}
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}
