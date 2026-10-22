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
// applying signed deltas to the opening balance, then we reverse for display
// so newest sits on top. v1.18.1 (NCC#176) — a move to or from the portfolio
// (Deposit, Withdraw, Savings "Invest") is a row of its own, and the walk
// starts from the opening as it was before any move (lib/accountStatement), so
// each row is the balance on its date and the top row is the header balance.
// "Opened" shows that same pre-move opening, so Opened + Net change = balance.

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
import {
  compareStatementRows,
  portfolioMoveRows,
  statementOpening,
  statementRunningBalances,
  type StatementRow,
} from '../../lib/accountStatement';
import { convertSync } from '../../api/fxRates';
import type { PortfolioCashEntry, Transaction } from '../../types/finance';
import { LIABILITY_TYPES } from '../../types/finance';


function fmt(amount: number, currency: string): string {
  return formatMoney(amount, currency, { locale: formatLocale() });
}

interface RowEntry {
  key: string;
  /** Null on a portfolio move row (NCC#176). */
  txn: Transaction | null;
  move: PortfolioCashEntry | null;
  /** `YYYY-MM-DD`, local. */
  date: string;
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
  kind: 'expense' | 'income' | 'transfer_in' | 'transfer_out' | 'to_portfolio' | 'from_portfolio';
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
  const { rows, opening, txnCount, unconvertibleMoves } = useMemo<{
    rows: RowEntry[];
    opening: number;
    txnCount: number;
    unconvertibleMoves: number;
  }>(() => {
    if (!account) return { rows: [], opening: 0, txnCount: 0, unconvertibleMoves: 0 };

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

    // v1.18.1 (NCC#176): the account's portfolio moves join as rows.
    // Oldest-first by date+createdAt so the running balance accumulates
    // chronologically. Secondary createdAt sort handles same-day events
    // (which would otherwise be order-undefined and produce flickering
    // running balances on re-render).
    type Item = StatementRow & { m?: (typeof matched)[number] };
    const moves = portfolioMoveRows(account, cashEntries, fxRates);
    const items: Item[] = [
      ...matched.map((m) => ({ date: m.txn.date, createdAt: m.txn.createdAt, delta: m.delta, m })),
      ...moves.rows,
    ].sort(compareStatementRows);
    const balances = statementRunningBalances(account.startingBalance, items);

    const built: RowEntry[] = items.map((item, i) => {
      if (!item.m) {
        const move = item.move!;
        return {
          key: `move:${move.id}`,
          txn: null,
          move,
          date: item.date,
          delta: item.delta,
          runningBalance: balances[i],
          counterparty: move.note || null,
          kind: move.type === 'deposit' ? 'to_portfolio' : 'from_portfolio',
        };
      }
      const m = item.m;
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
        key: m.txn.id,
        txn: m.txn,
        move: null,
        date: m.txn.date,
        delta: m.delta,
        runningBalance: balances[i],
        counterparty,
        kind: m.kind,
      };
    });

    // Reverse — newest sits on top of the list (canonical statement view).
    return {
      rows: built.reverse(),
      opening: statementOpening(account.startingBalance, items),
      txnCount: matched.length,
      unconvertibleMoves: moves.unconvertible,
    };
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
  // v1.18.1 (NCC#176) — measured from the pre-move opening, like the rows.
  const delta = balanceNative - opening;
  const deltaTone = delta > 0 ? 'success' : delta < 0 ? 'danger' : 'neutral';
  // v1.18.1 (NCC#176) — a move that could not be converted is missing from
  // the rows and from "Opened", so it is counted in the same notice.
  const unconvertableCount = (balance?.unconvertableTxns.length ?? 0) + unconvertibleMoves;

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
                {fmt(opening, account.currency)}
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
              <div className="text-xs font-medium">{txnCount}</div>
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
                r.kind === 'income' || r.kind === 'transfer_in' || r.kind === 'from_portfolio'
                  ? 'text-success'
                  : 'text-danger';
              const glyph =
                r.kind === 'income'
                  ? '↑'
                  : r.kind === 'expense'
                    ? '↓'
                    : r.kind === 'transfer_in' || r.kind === 'from_portfolio'
                      ? '⇇'
                      : '⇉';
              const body = (
                <>
                  <span className={`text-base ${tone} w-5 text-center`}>
                    {glyph}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">
                      {r.txn
                        ? r.txn.description
                        : t(r.kind === 'to_portfolio' ? 'fin.ad.toPortfolio' : 'fin.ad.fromPortfolio')}
                    </div>
                    <div className="text-[0.625rem] text-text-muted truncate">
                      {r.date}
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
                </>
              );
              const rowClass = 'w-full flex items-center gap-2 py-2 border-b border-border/40 last:border-0 text-start';
              // v1.18.1 (NCC#176) — a move is not a transaction, so there is
              // nothing to open in the transaction editor.
              if (!r.txn) {
                return (
                  <div key={r.key} className={rowClass}>
                    {body}
                  </div>
                );
              }
              const txnId = r.txn.id;
              return (
                <button
                  key={r.key}
                  type="button"
                  onClick={() => navigate(`/finance/add?id=${txnId}`)}
                  className={`${rowClass} press-spring`}
                >
                  {body}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}
