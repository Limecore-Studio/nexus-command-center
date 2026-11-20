// v1.9 Item 14b #4 — CSV transaction import / export.
//
// The plan calls this "table stakes for every competing budgeting tool and
// close to impossible to do well on a phone", and the width is the point: the
// mapping strip shows every column in the file at once with a live sample from
// the user's own data, so mapping is recognition rather than recall.
//
// DESIGN — a workbench, not a wizard.
// Wizards hide the thing you are reasoning about. Here every stage stays on
// screen once reached: change the date order at the top and the preview at the
// bottom re-reads instantly, which is the whole feedback loop this screen
// exists to provide. The three stages read as one column of panel panels with
// cyan step markers, matching the Cyber Slate language rather than inventing a
// second one.
//
// The honesty rule this screen is built around: never silently drop a row.
// Unparseable rows stay in the preview, flagged with WHY, and duplicates are
// deselected-but-visible rather than removed — because two identical coffees on
// one day is a real thing and only the user knows which it was.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import AppHeader from '../../components/AppHeader';
import { useFinanceStore } from '../../store/useFinanceStore';
import { useSettingsStore } from '../../store/useSettingsStore';
import { convertSync, ensureFxRates } from '../../api/fxRates';
import { formatMoney } from '../../lib/currencies';
import { formatLocale } from '../../utils/formatters';
import {
  amountsInBase,
  buildRows,
  detectDateOrder,
  detectDecimalSeparator,
  detectDelimiter,
  guessMapping,
  guessMappingFromData,
  looksLikeHeader,
  parseDelimited,
  stripBom,
  summarise,
  toCsv,
  type ColumnMapping,
  type ColumnRole,
  type DateOrder,
  type DecimalSeparator,
  type ImportRow,
} from '../../lib/csvImport';
import Glyph from '../../components/Glyph';

/** A bank export is tens of kilobytes. Anything past this is a wrong file, and
 *  parsing it would lock the tab rather than fail usefully. */
const MAX_BYTES = 5 * 1024 * 1024;

const ROLES: ColumnRole[] = [
  'ignore',
  'date',
  'description',
  'amount',
  'debit',
  'credit',
  'category',
  'notes',
];

const PREVIEW_GRID = 'grid-cols-[2.25rem_2.75rem_6.5rem_minmax(8.75rem,1fr)_minmax(5.625rem,8.25rem)_6.875rem_5.75rem]';

export default function ImportTransactions() {
  const { t } = useTranslation();
  const accounts = useFinanceStore((s) => s.manualAssets);
  const categories = useFinanceStore((s) => s.budgetCategories);
  const transactions = useFinanceStore((s) => s.transactions);
  const addBulk = useFinanceStore((s) => s.addTransactionsBulk);
  const addCategory = useFinanceStore((s) => s.addBudgetCategory);
  const baseCurrency = useSettingsStore((s) => s.baseCurrency);
  const locale = formatLocale();

  const fileInput = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [raw, setRaw] = useState<string[][] | null>(null);
  const [delimiter, setDelimiter] = useState(',');
  const [hasHeader, setHasHeader] = useState(true);
  const [mapping, setMapping] = useState<ColumnMapping>([]);
  const [dateOrder, setDateOrder] = useState<DateOrder>('dmy');
  const [dateAmbiguous, setDateAmbiguous] = useState(false);
  const [decimal, setDecimal] = useState<DecimalSeparator>('.');
  const [invertSign, setInvertSign] = useState(false);
  const [accountId, setAccountId] = useState('');
  const [createCategories, setCreateCategories] = useState(true);
  const [overrides, setOverrides] = useState<Record<number, boolean>>({});
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [imported, setImported] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Default the target account to the first live checking account, which is
  // what a bank export almost always is.
  useEffect(() => {
    if (accountId) return;
    const live = accounts.filter((a) => !a.archivedAt);
    const preferred = live.find((a) => a.accountType === 'checking') ?? live[0];
    // HYG-4: Overridable default target account; guarded so it fires once.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (preferred) setAccountId(preferred.id);
  }, [accounts, accountId]);

  const headers = useMemo(() => {
    if (!raw || raw.length === 0) return [];
    const width = raw.reduce((w, r) => Math.max(w, r.length), 0);
    if (hasHeader) {
      return Array.from({ length: width }, (_, i) => raw[0][i] ?? t('fin.imp.columnN', { n: i + 1 }));
    }
    return Array.from({ length: width }, (_, i) => t('fin.imp.columnN', { n: i + 1 }));
  }, [raw, hasHeader, t]);

  const dataRows = useMemo(
    () => (raw ? (hasHeader ? raw.slice(1) : raw) : []),
    [raw, hasHeader],
  );

  const reset = () => {
    setRaw(null);
    setFileName(null);
    setMapping([]);
    setError(null);
    setOverrides({});
    if (fileInput.current) fileInput.current.value = '';
  };

  const ingest = async (file: File) => {
    setError(null);
    setImported(null);
    if (file.size > MAX_BYTES) {
      setError(t('fin.imp.tooBig', { mb: Math.round(MAX_BYTES / 1024 / 1024) }));
      return;
    }
    let text: string;
    try {
      text = stripBom(await file.text());
    } catch {
      setError(t('fin.imp.unreadable'));
      return;
    }
    const delim = detectDelimiter(text);
    const parsed = parseDelimited(text, delim);
    if (parsed.length === 0) {
      setError(t('fin.imp.emptyFile'));
      return;
    }
    setFileName(file.name);
    setDelimiter(delim);
    setHasHeader(looksLikeHeader(parsed[0]));
    setOverrides({});
    setRaw(parsed);
  };

  // Mapping is re-guessed whenever the file or the header decision changes.
  // Header names beat content inference; content fills the gaps a partially
  // recognised header row leaves behind.
  useEffect(() => {
    if (!raw || raw.length === 0) return;
    const width = raw.reduce((w, r) => Math.max(w, r.length), 0);
    const body = hasHeader ? raw.slice(1) : raw;
    const byName = hasHeader
      ? guessMapping(Array.from({ length: width }, (_, i) => raw[0][i] ?? ''))
      : Array.from({ length: width }, () => 'ignore' as ColumnRole);
    const byData = guessMappingFromData(body);
    const merged = byName.map((role, i) => {
      if (role !== 'ignore') return role;
      const guess = byData[i] ?? 'ignore';
      return byName.includes(guess) ? 'ignore' : guess;
    });
    // HYG-4: Auto-detected column mapping. Derived once, then owned and edited by the
    // user — which is exactly why it has to land in state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMapping(merged);
  }, [raw, hasHeader]);

  // Date order and decimal separator are properties of the mapped columns, so
  // they re-detect when the user re-maps.
  useEffect(() => {
    if (!raw || mapping.length === 0) return;
    const di = mapping.indexOf('date');
    if (di >= 0) {
      const detected = detectDateOrder(dataRows.map((r) => r[di] ?? ''));
      // HYG-4: Re-detected when the mapping changes, then user-overridable. Same
      // ownership handoff as the mapping above.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDateOrder(detected.order);
      setDateAmbiguous(detected.ambiguous);
    } else {
      setDateAmbiguous(false);
    }
    const amountCols = [mapping.indexOf('amount'), mapping.indexOf('debit'), mapping.indexOf('credit')]
      .filter((i) => i >= 0);
    if (amountCols.length > 0) {
      setDecimal(detectDecimalSeparator(dataRows.flatMap((r) => amountCols.map((i) => r[i] ?? ''))));
    }
  }, [raw, mapping, dataRows]);

  // Dedup is scoped to the target account — the same €4.50 on the same day can
  // legitimately exist on two different cards.
  const existingForAccount = useMemo(
    () => (accountId ? transactions.filter((tx) => tx.accountId === accountId) : transactions),
    [transactions, accountId],
  );

  const built = useMemo(
    () =>
      mapping.length === 0
        ? []
        : buildRows({ rows: dataRows, mapping, dateOrder, decimal, invertSign, existing: existingForAccount }),
    [dataRows, mapping, dateOrder, decimal, invertSign, existingForAccount],
  );

  // Re-deriving the rows invalidates any manual selection — the user was
  // choosing against a different reading of the file.
  useEffect(() => {
    // HYG-4: Deliberate invalidation, not synchronisation: the per-row overrides were
    // chosen against a different reading of the file and are meaningless once
    // the parse changes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOverrides({});
  }, [built]);

  const rows: ImportRow[] = useMemo(
    () =>
      built.map((r) =>
        overrides[r.line] === undefined
          ? r
          : { ...r, selected: overrides[r.line] && r.problems.length === 0 },
      ),
    [built, overrides],
  );

  const stats = useMemo(() => summarise(rows), [rows]);
  const categoryByName = useMemo(
    () => new Map(categories.map((c) => [c.name.trim().toLowerCase(), c.id])),
    [categories],
  );
  const newCategoryNames = useMemo(() => {
    const out = new Set<string>();
    for (const r of rows) {
      const n = r.categoryName?.trim();
      if (r.selected && n && !categoryByName.has(n.toLowerCase())) out.add(n);
    }
    return [...out];
  }, [rows, categoryByName]);

  const toggleRow = (line: number, next: boolean) =>
    setOverrides((o) => ({ ...o, [line]: next }));

  const setAll = (next: boolean) => {
    const o: Record<number, boolean> = {};
    for (const r of rows) if (r.problems.length === 0) o[r.line] = next;
    setOverrides(o);
  };

  const setRole = (index: number, role: ColumnRole) =>
    setMapping((m) => {
      const next = [...m];
      // Roles other than `notes` are single-occupancy: assigning one steals it
      // from whichever column held it, rather than producing two "Amount"
      // columns where only the first would ever be read.
      if (role !== 'ignore' && role !== 'notes') {
        next.forEach((r, i) => {
          if (r === role && i !== index) next[i] = 'ignore';
        });
      }
      next[index] = role;
      return next;
    });

  const canImport =
    !busy && stats.selected > 0 && !!accountId && mapping.includes('date') &&
    (mapping.includes('amount') || mapping.includes('debit') || mapping.includes('credit'));

  const doImport = async () => {
    const selected = rows.filter((r) => r.selected && r.date && r.amount != null);
    if (selected.length === 0 || !accountId) return;
    setBusy(true);
    setError(null);
    try {
      let byName = categoryByName;
      if (createCategories && newCategoryNames.length > 0) {
        for (const name of newCategoryNames) {
          // No invented budget: an imported category has no limit until the
          // user sets one. `monthlyLimit: 0` is read everywhere as "not
          // budgeted", never as "budget of zero, therefore overspent".
          await addCategory({ name, monthlyLimit: 0, icon: '🗂' });
        }
        byName = new Map(
          useFinanceStore.getState().budgetCategories.map((c) => [c.name.trim().toLowerCase(), c.id]),
        );
      }
      // v1.22 (NCC#254): the statement is in the account's currency; a
      // transaction's amount is in the base currency.
      const account = accounts.find((a) => a.id === accountId);
      const accountCurrency = account?.currency ?? baseCurrency;
      let rates = useFinanceStore.getState().fxRates;
      if (accountCurrency !== baseCurrency && !rates) rates = (await ensureFxRates())?.rates ?? null;
      const amounts = amountsInBase(
        selected.map((r) => r.amount as number),
        accountCurrency,
        baseCurrency,
        (a, from, to) => convertSync(a, from, to, rates),
      );
      if (!amounts) {
        setError(t('fin.sg.fxConvertFail', { from: accountCurrency, to: baseCurrency }));
        return;
      }
      const n = await addBulk(
        selected.map((r, i) => ({
          amount: amounts[i],
          description: r.description,
          date: r.date as string,
          type: r.type,
          categoryId: r.categoryName ? byName.get(r.categoryName.trim().toLowerCase()) : undefined,
          notes: r.notes ?? undefined,
          accountId,
        })),
      );
      setImported(n);
      reset();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const doExport = () => {
    const nameOf = (id: string | undefined) => categories.find((c) => c.id === id)?.name ?? '';
    const ordered = [...transactions].sort((a, b) => a.date.localeCompare(b.date));
    const blob = new Blob([toCsv(ordered, nameOf)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `nexus-transactions-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const money = (v: number) => formatMoney(v, baseCurrency, { locale });

  return (
    <>
      <AppHeader title={t('fin.imp.title')} back="/finance" backLabel={t('fin.finance')} />

      <div className="space-y-3 desktop:max-w-[1100px]">
        {imported != null && (
          <div className="alert alert-ok" role="status">
            <Glyph name="check" size={12} />
            {t('fin.imp.doneCount', { count: imported })}
          </div>
        )}
        {error && (
          <div className="alert alert-danger" role="alert">
            <span aria-hidden>!</span>
            {error}
          </div>
        )}

        {/* ── 1. File ─────────────────────────────────────────────────── */}
        <Panel step={1} title={t('fin.imp.stepFile')}>
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              const f = e.dataTransfer.files?.[0];
              if (f) void ingest(f);
            }}
            className={`rounded-md border border-dashed p-6 text-center transition-colors ${
              dragging ? 'border-primary bg-primary/10' : 'border-border bg-surface2/40'
            }`}
          >
            <div className="mb-1.5 flex justify-center text-text-muted">
              <Glyph name={fileName ? 'file' : 'download'} size={22} strokeWidth={1.5} />
            </div>
            <div className="text-sm font-heading font-semibold">
              {fileName ?? t('fin.imp.dropHere')}
            </div>
            <div className="text-[0.6875rem] text-text-muted mt-0.5">
              {fileName
                ? t('fin.imp.rowsFound', { count: dataRows.length })
                : t('fin.imp.dropHint')}
            </div>
            <div className="flex items-center justify-center gap-2 mt-3 flex-wrap">
              <button type="button" className="btn btn-sm" onClick={() => fileInput.current?.click()}>
                {t('fin.imp.chooseFile')}
              </button>
              {fileName && (
                <button type="button" className="btn-ghost btn-sm" onClick={reset}>
                  {t('fin.imp.clear')}
                </button>
              )}
              <button type="button" className="btn-ghost btn-sm" onClick={doExport} disabled={transactions.length === 0}>
                {t('fin.imp.exportAll', { count: transactions.length })}
              </button>
            </div>
            <input
              ref={fileInput}
              type="file"
              accept=".csv,.txt,text/csv,text/plain"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void ingest(f);
              }}
            />
          </div>
        </Panel>

        {raw && (
          <>
            {/* ── 2. Mapping ──────────────────────────────────────────── */}
            <Panel step={2} title={t('fin.imp.stepMap')}>
              {/* One card per column of the file, each carrying a live sample
                  from the user's own data. Recognition, not recall — and it is
                  the surface that genuinely needs the desktop width. */}
              <div className="grid gap-2 grid-cols-[repeat(auto-fit,minmax(11.875rem,1fr))]">
                {headers.map((h, i) => {
                  const samples = dataRows.slice(0, 3).map((r) => (r[i] ?? '').trim()).filter(Boolean);
                  const active = mapping[i] && mapping[i] !== 'ignore';
                  return (
                    <div
                      key={i}
                      className={`rounded-md border p-2 ${
                        active ? 'border-primary/50 bg-primary/[0.06]' : 'border-border bg-surface2/40'
                      }`}
                    >
                      <div className="sec truncate" title={h}>
                        {h}
                      </div>
                      <div className="text-[0.6875rem] text-text-muted truncate h-4" title={samples.join(' · ')}>
                        {samples[0] ?? '—'}
                      </div>
                      <select
                        aria-label={t('fin.imp.roleFor', { column: h })}
                        className="input mt-1.5 py-1.5 text-xs"
                        value={mapping[i] ?? 'ignore'}
                        onChange={(e) => setRole(i, e.target.value as ColumnRole)}
                      >
                        {ROLES.map((r) => (
                          <option key={r} value={r}>
                            {t(`fin.imp.role.${r}`)}
                          </option>
                        ))}
                      </select>
                    </div>
                  );
                })}
              </div>

              <div className="grid gap-2 mt-3 grid-cols-1 tablet:grid-cols-2 desktop:grid-cols-4">
                <Field label={t('fin.imp.account')}>
                  <select className="input py-2 text-xs" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                    {accounts.filter((a) => !a.archivedAt).map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={t('fin.imp.dateOrder')}>
                  <select
                    className={`input py-2 text-xs ${dateAmbiguous ? 'border-warning' : ''}`}
                    value={dateOrder}
                    onChange={(e) => setDateOrder(e.target.value as DateOrder)}
                  >
                    <option value="dmy">{t('fin.imp.dmy')}</option>
                    <option value="mdy">{t('fin.imp.mdy')}</option>
                    <option value="ymd">{t('fin.imp.ymd')}</option>
                  </select>
                </Field>
                <Field label={t('fin.imp.decimal')}>
                  <select
                    className="input py-2 text-xs"
                    value={decimal}
                    onChange={(e) => setDecimal(e.target.value as DecimalSeparator)}
                  >
                    <option value=".">{t('fin.imp.decDot')}</option>
                    <option value=",">{t('fin.imp.decComma')}</option>
                  </select>
                </Field>
                <Field label={t('fin.imp.delimiter')}>
                  <div className="input py-2 text-xs text-text-muted">
                    {delimiter === '\t' ? t('fin.imp.tab') : delimiter}
                  </div>
                </Field>
              </div>

              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 mt-3">
                <Check checked={hasHeader} onChange={setHasHeader} label={t('fin.imp.firstRowHeader')} />
                <Check checked={invertSign} onChange={setInvertSign} label={t('fin.imp.invertSign')} />
                <Check checked={createCategories} onChange={setCreateCategories} label={t('fin.imp.createCategories')} />
              </div>

              {/* The one guess we refuse to make silently. */}
              {dateAmbiguous && (
                <div className="alert alert-warn mt-3">
                  <Glyph name="warning" size={12} />
                  {t('fin.imp.dateAmbiguous')}
                </div>
              )}
              {createCategories && newCategoryNames.length > 0 && (
                <div className="text-[0.6875rem] text-text-muted mt-2">
                  {t('fin.imp.willCreate', { count: newCategoryNames.length, names: newCategoryNames.slice(0, 4).join(', ') })}
                </div>
              )}
              <div className="text-[0.6875rem] text-text-muted mt-2">{t('fin.imp.noTransfers')}</div>
            </Panel>

            {/* ── 3. Review ───────────────────────────────────────────── */}
            <Panel step={3} title={t('fin.imp.stepReview')}>
              <div className="flex flex-wrap items-center gap-2 mb-2">
                <Tally value={stats.selected} label={t('fin.imp.selected')} tone="primary" />
                <Tally value={stats.duplicates} label={t('fin.imp.duplicates')} tone={stats.duplicates ? 'warning' : 'muted'} />
                <Tally value={stats.problems} label={t('fin.imp.skipped')} tone={stats.problems ? 'danger' : 'muted'} />
                <div className="flex-1" />
                <button type="button" className="btn-ghost btn-sm" onClick={() => setAll(true)}>
                  {t('fin.imp.selectAll')}
                </button>
                <button type="button" className="btn-ghost btn-sm" onClick={() => setAll(false)}>
                  {t('fin.imp.selectNone')}
                </button>
              </div>

              <div className="overflow-x-auto">
                <div role="table" aria-label={t('fin.imp.previewAria')} className="min-w-[45rem]">
                  <div role="row" className={`grid ${PREVIEW_GRID} gap-2 px-2 pb-1.5 border-b border-border`}>
                    <span role="columnheader" className="sr-only">{t('fin.imp.include')}</span>
                    <span role="columnheader" className="sec text-end">#</span>
                    <span role="columnheader" className="sec">{t('fin.imp.date')}</span>
                    <span role="columnheader" className="sec">{t('fin.imp.description')}</span>
                    <span role="columnheader" className="sec">{t('fin.imp.category')}</span>
                    <span role="columnheader" className="sec text-end">{t('fin.imp.amount')}</span>
                    <span role="columnheader" className="sec">{t('fin.imp.status')}</span>
                  </div>
                  {/* Capped render: a 4 000-row export would otherwise mount
                      4 000 rows to prove a point. The count below says exactly
                      how many are hidden — a silent cap would read as "that is
                      the whole file". */}
                  {rows.slice(0, 300).map((r) => {
                    const broken = r.problems.length > 0;
                    return (
                      <div
                        key={r.line}
                        role="row"
                        className={`grid ${PREVIEW_GRID} gap-2 px-2 py-1.5 border-b border-border/40 items-center text-xs ${
                          broken ? 'opacity-50' : ''
                        }`}
                      >
                        <span role="cell">
                          <input
                            type="checkbox"
                            className="accent-primary"
                            checked={r.selected}
                            disabled={broken}
                            onChange={(e) => toggleRow(r.line, e.target.checked)}
                            aria-label={t('fin.imp.includeRow', { line: r.line })}
                          />
                        </span>
                        <span role="cell" className="text-end tabular-nums text-text-muted">{r.line}</span>
                        <span role="cell" className="tabular-nums">
                          {r.date ?? <span className="text-danger">{t('fin.imp.bad')}</span>}
                        </span>
                        <span role="cell" className="truncate" title={r.description}>
                          {r.description || <span className="text-danger">{t('fin.imp.bad')}</span>}
                        </span>
                        <span role="cell" className="truncate text-text-muted" title={r.categoryName ?? ''}>
                          {r.categoryName ?? '—'}
                        </span>
                        <span
                          role="cell"
                          className={`text-end tabular-nums ${r.type === 'income' ? 'text-success' : 'text-text'}`}
                        >
                          {r.amount == null ? (
                            <span className="text-danger">{t('fin.imp.bad')}</span>
                          ) : (
                            `${r.type === 'income' ? '+' : '−'}${money(r.amount)}`
                          )}
                        </span>
                        <span role="cell" className="text-[0.625rem] uppercase tracking-wider">
                          {broken ? (
                            <span className="text-danger">
                              {r.problems.map((p) => t(`fin.imp.problem.${p}`)).join(', ')}
                            </span>
                          ) : r.duplicate ? (
                            <span className="text-warning">{t(`fin.imp.dup.${r.duplicate}`)}</span>
                          ) : (
                            <span className="text-text-muted">{t('fin.imp.ok')}</span>
                          )}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
              {rows.length > 300 && (
                <div className="text-[0.6875rem] text-text-muted mt-2">
                  {t('fin.imp.truncated', { shown: 300, total: rows.length })}
                </div>
              )}

              <div className="flex items-center gap-2 mt-3">
                <button type="button" className="btn" disabled={!canImport} onClick={() => void doImport()}>
                  {busy ? t('fin.imp.importing') : t('fin.imp.importCount', { count: stats.selected })}
                </button>
                <button type="button" className="btn-ghost" onClick={reset}>
                  {t('fin.imp.cancel')}
                </button>
              </div>
              {!accountId && <div className="text-[0.6875rem] text-danger mt-2">{t('fin.imp.needAccount')}</div>}
            </Panel>
          </>
        )}
      </div>
    </>
  );
}

/** Numbered panel. The step marker is the only chrome — it carries the
 *  sequence without a wizard's forced linearity. */
function Panel({ step, title, children }: { step: number; title: string; children: React.ReactNode }) {
  return (
    <section className="card">
      <div className="flex items-center gap-2 mb-3">
        <span className="w-5 h-5 rounded-full border border-primary/50 bg-primary/10 text-primary text-[0.625rem] font-heading font-semibold flex items-center justify-center flex-shrink-0">
          {step}
        </span>
        <h2 className="font-heading font-semibold text-sm">{title}</h2>
      </div>
      {children}
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="sec block mb-1">{label}</span>
      {children}
    </label>
  );
}

function Check({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <label className="flex items-center gap-2 text-xs text-text-muted cursor-pointer">
      <input
        type="checkbox"
        className="accent-primary"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
    </label>
  );
}

function Tally({ value, label, tone }: { value: number; label: string; tone: 'primary' | 'warning' | 'danger' | 'muted' }) {
  const cls =
    tone === 'primary'
      ? 'text-primary border-primary/40 bg-primary/10'
      : tone === 'warning'
        ? 'text-warning border-warning/40 bg-warning/5'
        : tone === 'danger'
          ? 'text-danger border-danger/40 bg-danger/5'
          : 'text-text-muted border-border';
  return (
    <span className={`inline-flex items-baseline gap-1.5 rounded-sm border px-2.5 py-1 text-[0.625rem] uppercase tracking-wider ${cls}`}>
      <b className="font-heading text-xs tabular-nums">{value}</b>
      {label}
    </span>
  );
}
