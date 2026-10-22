// ─── v1.3.2 — Portfolio cash card ──────────────────────────────────────────
//
// Surfaces the portfolio's uninvested cash balance (sale proceeds + deposits −
// buys − withdrawals, all in base currency) and lets the user move cash in
// from / out to a liquid account — the mirror of the Savings "Invest" sheet.
// Buys draw this down; if it goes negative the card prompts the user to
// deposit to cover. Self-contained: reads + writes the finance store directly.

import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { formatMoney } from '../lib/currencies';
import { formatLocale } from '../utils/formatters';
import { useFinanceStore } from '../store/useFinanceStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { portfolioCashBalance } from '../lib/portfolioCash';
import type { ManualAssetType } from '../types/finance';
// v1.18.1 (NCC#144): typed amounts accept a decimal comma.
import { numberInput } from '@/lib/numberInput';

const LIQUID_TYPES: ManualAssetType[] = ['cash', 'savings', 'checking'];

function fmt(amount: number, currency: string): string {
  const body = formatMoney(amount, currency, { locale: formatLocale(), signed: false });
  return amount < 0 ? `−${body}` : body;
}

export default function PortfolioCashCard() {
  const cashEntries = useFinanceStore((s) => s.portfolioCashEntries);
  const manualAssets = useFinanceStore((s) => s.manualAssets);
  const fxRates = useFinanceStore((s) => s.fxRates);
  const deposit = useFinanceStore((s) => s.depositToPortfolio);
  const withdraw = useFinanceStore((s) => s.withdrawFromPortfolio);
  const baseCurrency = useSettingsStore((s) => s.baseCurrency);
  const navigate = useNavigate();
  const { t } = useTranslation();

  const cash = useMemo(
    () => portfolioCashBalance(cashEntries, baseCurrency, fxRates),
    [cashEntries, baseCurrency, fxRates],
  );

  const liquidAccounts = useMemo(
    () => manualAssets.filter((a) => LIQUID_TYPES.includes(a.accountType) && !a.archivedAt),
    [manualAssets],
  );

  const [mode, setMode] = useState<null | 'deposit' | 'withdraw'>(null);
  const [amount, setAmount] = useState('');
  const [accountId, setAccountId] = useState('');
  const [error, setError] = useState<string | null>(null);

  const open = (m: 'deposit' | 'withdraw') => {
    setMode(m);
    setAmount('');
    setAccountId(liquidAccounts[0]?.id ?? '');
    setError(null);
  };
  const cancel = () => { setMode(null); setError(null); };

  const submit = async () => {
    const amt = numberInput(amount);
    if (!(amt > 0) || !accountId) return;
    try {
      if (mode === 'deposit') await deposit({ amount: amt, currency: baseCurrency, accountId });
      else await withdraw({ amount: amt, currency: baseCurrency, accountId });
      cancel();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  // Nothing to show until there's either cash movement or a liquid account to
  // fund from — keeps the Portfolio tab clean for brand-new users.
  if (cashEntries.length === 0 && liquidAccounts.length === 0) return null;

  const negative = cash < -1e-9;

  return (
    <div className="card">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-[0.625rem] uppercase tracking-[0.15em] text-text-muted">
            Portfolio cash
          </div>
          <div className={`font-heading font-bold text-xl ${negative ? 'text-danger' : 'text-text'}`}>
            {fmt(cash, baseCurrency)}
          </div>
        </div>
        {mode === null && (
          <div className="flex gap-2">
            <button
              onClick={() => open('deposit')}
              className="text-xs px-2.5 py-1 rounded-sm border border-primary text-primary active:bg-primary/10"
            >
              + Deposit
            </button>
            <button
              onClick={() => open('withdraw')}
              disabled={cash <= 0}
              className="text-xs px-2.5 py-1 rounded-sm border border-border text-text-muted active:text-text active:border-border disabled:opacity-40"
            >
              Withdraw
            </button>
          </div>
        )}
      </div>

      {negative && mode === null && (
        <div className="text-[0.625rem] text-danger mt-1">
          Negative — deposit cash to cover your purchases.
        </div>
      )}

      {mode !== null && (
        <div className="mt-3 space-y-2">
          <div className="text-[0.6875rem] uppercase tracking-wider text-text-muted">
            {mode === 'deposit' ? 'Deposit from account → portfolio' : 'Withdraw portfolio → account'}
          </div>
          <div className="flex gap-2">
            <input
              className="input flex-1"
              placeholder={`Amount (${baseCurrency})`}
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              autoFocus
            />
            <select
              className="input flex-1"
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
            >
              {liquidAccounts.length === 0 && <option value="">No liquid account</option>}
              {liquidAccounts.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          </div>
          {error && <div className="text-[0.6875rem] text-danger">{error}</div>}
          <div className="flex gap-2">
            <button
              className="btn flex-1"
              onClick={submit}
              disabled={!(numberInput(amount) > 0) || !accountId}
            >
              {mode === 'deposit' ? 'Deposit' : 'Withdraw'}
            </button>
            <button className="btn-ghost flex-1" onClick={cancel}>Cancel</button>
          </div>
          {/* v1.19 (NCC#202): the same move on a schedule. */}
          {mode === 'deposit' && (
            <button
              type="button"
              className="text-[0.6875rem] text-text-muted active:text-text"
              onClick={() => navigate('/finance/recurring?new=cash_deposit')}
            >
              {t('recurring.addRecurring')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
