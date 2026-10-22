// ─── v1.2 follow-up — CTO Account refactor: AccountDetail screen ───────
//
// Per-account view at `/finance/account/:id`. Header shows the account's
// derived balance + opening figure + a delta strip. Body lists every
// transaction that touched the account (expense / income / transfer-in /
// transfer-out) newest first, with a running-balance column so the user
// can scrub backwards through history.
//
// Filter rules:
//   - expense / income where `t.accountId === account.id` → debit / credit
//   - transfer where `t.accountId === account.id` → transfer-out (debit)
//   - transfer where `t.destinationAccountId === account.id` → transfer-in
//
// The running balance is computed by walking the transactions oldest-first
// applying signed deltas to `account.startingBalance`, then we reverse for
// display so newest sits on top. Rows dated before a move to or from the
// portfolio add that move back (lib/accountStatement, NCC#164), so each row is
// the balance on its date; when a move came after the newest transaction, the
// top row differs from the header balance by that move. A move in another
// currency is added back at today's rate, as the net-worth trend does.

import { useMemo } from 'react';
import { formatMoney } from '../../lib/currencies';
import { formatLocale } from '../../utils/formatters';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';
import AppHeader from '../../components/AppHeader';
import { Pill } from '../../components/ui/Pill';
import { useFinanceStore } from '../../store/useFinanceStore';
import { useSettingsStore } from '../../store/useSettingsStore';
import { computeAccountBalance } from '../../lib/accountBalance';
import { statementRunningBalances } from '../../lib/accountStatement';
import { convertSync } from '../../api/fxRates';
import type { Transaction } from '../../types/finance';
import { LIABILITY_TYPES } from '../../types/finance';


function fmt(amount: number, currency: string): string {
  return formatMoney(amount, currency, { locale: formatLocale() });
}

interface RowEntry {
  txn: Transaction;
  /** Signed delta applied to THIS account (in account.currency). Positive
   *  = inflow (income / transfer-in), negative = outflow (expense /
   *  transfer-out). */
  delta: number;
  /** Running balance AFTER this transaction. */
  runningBalance: number;
  /** Human-readable counterparty (e.g. "from Checking" on a transfer-in,
   *  category name on an expense). Null when not applicable. */
  counterparty: string | null;
  /** Render hint — drives the colour + leading glyph on the row. */
  kind: 'expense' | 'income' | 'transfer_in' | 'transfer_out';
}

export default function AccountDetail() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const baseCurrency = useSettingsStore((s) => s.baseCurrency);
  const accounts = useFinanceStore((s) => s.manualAssets);
  const allTransactions = useFinanceStore((s) => s.transactions);
  const categories = useFinanceStore((s) => s.budgetCategories);
  const fxRates = useFinanceStore((s) => s.fxRates);
  const cashEntries = useFinanceStore((s) => s.portfolioCashEntries);

  const account = useMemo(
    () => accounts.find((a) => a.id === id) ?? null,
    [accounts, id],
  );

  // Derived current balance — same helper Net Worth uses.
  const balance = useMemo(() => {
    if (!account) return null;
    return computeAccountBalance(
      account,
      allTransactions,
      fxRates,
      baseCurrency,
    );
  }, [account, allTransactions, fxRates, baseCurrency]);

  // Build the per-transaction view. Walk oldest-first applying deltas so
  // each row carries the post-transaction running balance, then reverse
  // for display (newest first). This is the only sane way to present a
  // bank-statement-style view — start with starting balance, apply each
  // event, finish at "balance".
  const rows = useMemo<RowEntry[]>(() => {
    if (!account) return [];

    // Helper — convert a baseCurrency amount into account.currency. Returns
    // null on missing FX rate (we just skip the row from the running
    // balance — same convention as computeAccountBalance).
    const toAccountCcy = (amount: number): number | null => {
      if (baseCurrency === account.currency) return amount;
      return convertSync(amount, baseCurrency, account.currency, fxRates);
    };

    // Filter + classify in one pass.
    const matched: Array<{ txn: Transaction; delta: number; kind: RowEntry['kind'] }> = [];
    for (const t of allTransactions) {
      if (t.type === 'expense' && t.accountId === account.id) {
        const c = toAccountCcy(t.amount);
        if (c == null) continue;
        matched.push({ txn: t, delta: -c, kind: 'expense' });
      } else if (t.type === 'income' && t.accountId === account.id) {
        const c = toAccountCcy(t.amount);
        if (c == null) continue;
        matched.push({ txn: t, delta: c, kind: 'income' });
      } else if (t.type === 'transfer') {
        if (t.accountId === account.id) {
          const c = toAccountCcy(t.amount);
          if (c == null) continue;
          matched.push({ txn: t, delta: -c, kind: 'transfer_out' });
        } else if (t.destinationAccountId === account.id) {
          const c = toAccountCcy(t.amount);
          if (c == null) continue;
          matched.push({ txn: t, delta: c, kind: 'transfer_in' });
        }
      }
    }

    // Oldest-first by date+createdAt so the running balance accumulates
    // chronologically. Secondary createdAt sort handles same-day events
    // (which would otherwise be order-undefined and produce flickering
    // running balances on re-render).
    matched.sort((a, b) => {
      const dateCmp = a.txn.date.localeCompare(b.txn.date);
      if (dateCmp !== 0) return dateCmp;
      return a.txn.createdAt.localeCompare(b.txn.createdAt);
    });

    // v1.18.1 (NCC#164): a row dated before a Deposit / Withdraw / Invest
    // adds the move back, since the move shifted the undated opening balance.
    const balances = statementRunningBalances(
      account,
      matched.map((m) => ({ date: m.txn.date, createdAt: m.txn.createdAt, delta: m.delta })),
      cashEntries,
      fxRates,
    );
    const built: RowEntry[] = matched.map((m, i) => {
      const cat = m.txn.categoryId
        ? categories.find((c) => c.id === m.txn.categoryId)
        : null;
      let counterparty: string | null = null;
      if (m.kind === 'transfer_in') {
        const src = accounts.find((a) => a.id === m.txn.accountId);
        counterparty = src ? t('fin.ad.fromName', { name: src.name }) : t('fin.ad.fromOther');
      } else if (m.kind === 'transfer_out') {
        const dst = accounts.find((a) => a.id === m.txn.destinationAccountId);
        counterparty = dst ? t('fin.ad.toName', { name: dst.name }) : t('fin.ad.toOther');
      } else if (cat) {
        counterparty = cat.name;
      }
      return {
        txn: m.txn,
        delta: m.delta,
        runningBalance: balances[i],
        counterparty,
        kind: m.kind,
      };
    });

    // Reverse — newest sits on top of the list (canonical statement view).
    return built.reverse();
  }, [account, allTransactions, cashEntries, categories, accounts, fxRates, baseCurrency, t]);

  if (!account) {
    return (
      <>
        <AppHeader
          title={t('fin.ad.account')}
          back="/finance/networth"
          backLabel={t('fin.ov.netWorth')}
          showAvatar={false}
        />
        <div className="card text-center text-xs text-text-muted py-6">
          {t('fin.ad.notFound')}
        </div>
      </>
    );
  }

  const isLiability = LIABILITY_TYPES.includes(account.accountType);
  const balanceNative = balance?.balance ?? 0;
  const delta = balanceNative - account.startingBalance;
  const deltaTone = delta > 0 ? 'success' : delta < 0 ? 'danger' : 'neutral';
  const unconvertableCount = balance?.unconvertableTxns.length ?? 0;

  return (
    <>
      <AppHeader
        title={account.name}
        back="/finance/networth"
        backLabel={t('fin.ov.netWorth')}
        showAvatar={false}
        action={
          <Pill size="sm" onClick={() => navigate('/finance/add')} icon="+">
            {t('fin.ad.txn')}
          </Pill>
        }
      />
      <div className="space-y-3">
        {/* Header card — derived balance + delta + opening */}
        <div className="card-elevated">
          <div className="text-[0.625rem] uppercase tracking-[0.15em] text-text-muted mb-1">
            {isLiability ? t('fin.ad.amountOwed') : t('fin.ad.currentBalance')}
          </div>
          <div
            className={`font-heading font-bold text-3xl tracking-tight ${
              isLiability && balanceNative < 0 ? 'text-danger' : 'text-text'
            }`}
          >
            {fmt(balanceNative, account.currency)}
          </div>
          <div className="grid grid-cols-3 gap-2 mt-3 pt-3 border-t border-border/40">
            <div>
              <div className="text-[0.625rem] uppercase tracking-wider text-text-muted">
                {t('fin.ad.opened')}
              </div>
              <div className="text-xs font-medium">
                {fmt(account.startingBalance, account.currency)}
              </div>
            </div>
            <div>
              <div className="text-[0.625rem] uppercase tracking-wider text-text-muted">
                {t('fin.ad.netChange')}
              </div>
              <div
                className={`text-xs font-medium ${
                  deltaTone === 'success'
                    ? 'text-success'
                    : deltaTone === 'danger'
                      ? 'text-danger'
                      : 'text-text-muted'
                }`}
              >
                {delta >= 0 ? '+' : ''}
                {fmt(delta, account.currency)}
              </div>
            </div>
            <div>
              <div className="text-[0.625rem] uppercase tracking-wider text-text-muted">
                {t('fin.ad.transactions')}
              </div>
              <div className="text-xs font-medium">{rows.length}</div>
            </div>
          </div>
          {unconvertableCount > 0 && (
            <div className="text-[0.625rem] text-warning mt-2">
              {t('fin.ad.unconvertable', { count: unconvertableCount, cur: account.currency })}
            </div>
          )}
        </div>

        {/* Statement list */}
        {rows.length === 0 ? (
          <div className="card text-center text-xs text-text-muted py-8">
            {t('fin.ad.noTx')}
          </div>
        ) : (
          <div className="card">
            <div className="font-heading font-semibold text-sm mb-2">
              {t('fin.ad.transactions')}
            </div>
            {rows.map((r) => {
              const tone =
                r.kind === 'income' || r.kind === 'transfer_in'
                  ? 'text-success'
                  : 'text-danger';
              const glyph =
                r.kind === 'income'
                  ? '↑'
                  : r.kind === 'expense'
                    ? '↓'
                    : r.kind === 'transfer_in'
                      ? '⇇'
                      : '⇉';
              return (
                <button
                  key={r.txn.id}
                  type="button"
                  onClick={() => navigate(`/finance/add?id=${r.txn.id}`)}
                  className="w-full flex items-center gap-2 py-2 border-b border-border/40 last:border-0 text-start press-spring"
                >
                  <span className={`text-base ${tone} w-5 text-center`}>
                    {glyph}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">
                      {r.txn.description}
                    </div>
                    <div className="text-[0.625rem] text-text-muted truncate">
                      {r.txn.date}
                      {r.counterparty ? ` · ${r.counterparty}` : ''}
                    </div>
                  </div>
                  <div className="text-end">
                    <div className={`text-sm font-semibold tabular-nums ${tone}`}>
                      {r.delta >= 0 ? '+' : ''}
                      {fmt(r.delta, account.currency)}
                    </div>
                    <div className="text-[0.625rem] text-text-muted tabular-nums">
                      {fmt(r.runningBalance, account.currency)}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}
