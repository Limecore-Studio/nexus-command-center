// v1.9 Item 14b #4 — CSV transaction import.
//
// The build plan is explicit that the work here is the mapping and dedup logic,
// not the upload button, and that is what this module is. It is pure: text in,
// a reviewed set of candidate transactions out. Nothing here touches Dexie, the
// store, or React, so the hard parts are testable in isolation — which matters
// more than usual given NCC has no test harness (HYG-2).
//
// The design constraint throughout: a bank export is somebody else's format and
// we do not get to dictate it. Rather than demand one canonical shape, we detect
// what we can, show the user what we decided, and let them override every guess.
// Where a guess is genuinely undecidable (see `detectDateOrder`) we say so
// instead of picking silently and being wrong 50% of the time.

import type { Transaction, TransactionType } from '../types/finance';
import { parseAmount, type DecimalSeparator } from './parseAmount';

// ─── Delimited-text parsing ────────────────────────────────────────────────

const CANDIDATE_DELIMITERS = [',', ';', '\t', '|'] as const;

/**
 * RFC-4180-shaped parser. Handles quoted fields, doubled quotes as an escape,
 * and embedded delimiters/newlines inside quotes — all of which occur in real
 * exports (a merchant called `AMAZON.COM*MK1QP, LLC` is not hypothetical).
 *
 * A quote only opens a field when it is the FIRST character of that field, so a
 * stray `12"` mid-value is data rather than the start of a run-on string that
 * swallows the rest of the file.
 */
export function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let quoted = false;
  let i = 0;

  const endField = () => {
    row.push(field);
    field = '';
    quoted = false;
  };

  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === '') {
      inQuotes = true;
      quoted = true;
      i++;
      continue;
    }
    if (ch === delimiter) {
      endField();
      i++;
      continue;
    }
    if (ch === '\r') {
      i++;
      continue;
    }
    if (ch === '\n') {
      endField();
      rows.push(row);
      row = [];
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  if (field !== '' || quoted || row.length > 0) {
    endField();
    rows.push(row);
  }
  // Blank trailing lines are near-universal in exported files; a row of one
  // empty cell is not a transaction.
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

/**
 * Pick the delimiter by parsing with each candidate and scoring the result,
 * rather than counting separators in the header line.
 *
 * Counting is the obvious approach and it is wrong on the exact files that
 * matter: a semicolon-delimited European export whose description fields are
 * full of commas out-counts its own real delimiter. Consistency of column count
 * across every row is the property a correct delimiter actually has.
 */
export function detectDelimiter(text: string): string {
  const sample = text.slice(0, 64_000);
  let best = ',';
  let bestScore = -1;
  for (const d of CANDIDATE_DELIMITERS) {
    const rows = parseDelimited(sample, d).slice(0, 50);
    if (rows.length === 0) continue;
    const counts = new Map<number, number>();
    for (const r of rows) counts.set(r.length, (counts.get(r.length) ?? 0) + 1);
    let modal = 0;
    let modalHits = 0;
    for (const [len, hits] of counts) {
      if (hits > modalHits || (hits === modalHits && len > modal)) {
        modal = len;
        modalHits = hits;
      }
    }
    if (modal < 2) continue;
    // Consistency dominates; column count breaks ties. A file that splits into
    // 4 columns on every line beats one that splits into 9 on some and 2 on
    // others, which is what a wrong delimiter looks like.
    const score = (modalHits / rows.length) * 100 + Math.min(modal, 20);
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best;
}

/* eslint-disable no-irregular-whitespace -- the doc comment below deliberately embeds a literal BOM character to illustrate the corruption */
/** Strips a UTF-8 BOM, which Excel writes and which otherwise corrupts the
 *  first header name (literal `﻿Date` never matches `date`). */
/* eslint-enable no-irregular-whitespace */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

// ─── Column mapping ────────────────────────────────────────────────────────

export type ColumnRole =
  | 'ignore'
  | 'date'
  | 'description'
  | 'amount'
  | 'debit'
  | 'credit'
  | 'category'
  | 'notes';

export type ColumnMapping = ColumnRole[];

/**
 * Header aliases, lowercased and stripped of non-letters before matching, so
 * `"Transaction Date"`, `transaction_date` and `TRANSACTION-DATE` all land on
 * the same rule. Ordered most-specific first within each role.
 */
const HEADER_HINTS: { role: Exclude<ColumnRole, 'ignore'>; match: string[] }[] = [
  { role: 'debit', match: ['debit', 'withdrawal', 'moneyout', 'paidout', 'outflow', 'expense', 'veloitus'] },
  { role: 'credit', match: ['credit', 'deposit', 'moneyin', 'paidin', 'inflow', 'income', 'hyvitys'] },
  { role: 'date', match: ['transactiondate', 'bookingdate', 'postingdate', 'valuedate', 'date', 'paivamaara', 'kirjauspaiva', 'datum'] },
  { role: 'amount', match: ['amount', 'value', 'sum', 'summa', 'betrag', 'montant', 'total'] },
  { role: 'description', match: ['description', 'payee', 'merchant', 'narrative', 'details', 'reference', 'name', 'memo', 'saaja', 'selite', 'beschreibung'] },
  { role: 'category', match: ['category', 'categorie', 'kategoria', 'kategorie', 'type', 'tyyppi'] },
  { role: 'notes', match: ['note', 'notes', 'comment', 'message', 'viesti'] },
];

function normaliseHeader(h: string): string {
  // Decompose first so `Kirjauspäivä` folds to `kirjauspaiva` rather than
  // losing the vowel entirely — a Finnish or German export otherwise fails to
  // match any hint and lands the user in full manual mapping for no reason.
  return h
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z]/g, '');
}

/**
 * Best-effort role per column. Every role except `notes` is assigned at most
 * once — the first column that matches wins, so a file with both `Date` and
 * `Value Date` maps the more specific one and leaves the other ignorable rather
 * than silently overwriting.
 */
export function guessMapping(headers: string[]): ColumnMapping {
  const mapping: ColumnMapping = headers.map(() => 'ignore');
  const taken = new Set<ColumnRole>();
  for (const { role, match } of HEADER_HINTS) {
    if (taken.has(role)) continue;
    let bestIdx = -1;
    let bestRank = Infinity;
    headers.forEach((h, i) => {
      if (mapping[i] !== 'ignore') return;
      const n = normaliseHeader(h);
      if (!n) return;
      const rank = match.findIndex((m) => n === m);
      const loose = rank === -1 ? match.findIndex((m) => n.includes(m)) : -1;
      const effective = rank !== -1 ? rank : loose !== -1 ? loose + 100 : Infinity;
      if (effective < bestRank) {
        bestRank = effective;
        bestIdx = i;
      }
    });
    if (bestIdx >= 0) {
      mapping[bestIdx] = role;
      taken.add(role);
    }
  }
  // A file with debit/credit columns does not also need a single amount column,
  // and vice versa — whichever pair is incomplete gets released back so the
  // user is not looking at a half-configured two-column mode.
  const hasPair = taken.has('debit') && taken.has('credit');
  if (hasPair) {
    const ai = mapping.indexOf('amount');
    if (ai >= 0) mapping[ai] = 'ignore';
  } else {
    mapping.forEach((r, i) => {
      if (r === 'debit' || r === 'credit') mapping[i] = 'ignore';
    });
  }
  return mapping;
}

/**
 * Guess roles from the DATA when there are no headers to read — a headerless
 * export is otherwise six manual dropdowns before the user sees anything.
 *
 * Content is a weaker signal than a header name, so this only claims the three
 * roles it can actually infer: the column that parses as dates, the column that
 * parses as amounts, and the widest free-text column as the description. It is
 * used as a fallback, never to override a header match.
 */
export function guessMappingFromData(rows: string[][]): ColumnMapping {
  const width = rows.reduce((w, r) => Math.max(w, r.length), 0);
  const mapping: ColumnMapping = Array.from({ length: width }, () => 'ignore' as ColumnRole);
  if (rows.length === 0 || width === 0) return mapping;

  const sample = rows.slice(0, 200);
  const dateHits: number[] = [];
  const amountHits: number[] = [];
  const textLen: number[] = [];

  for (let c = 0; c < width; c++) {
    let dates = 0;
    let amounts = 0;
    let chars = 0;
    let filled = 0;
    for (const r of sample) {
      const v = (r[c] ?? '').trim();
      if (!v) continue;
      filled++;
      chars += v.length;
      // `ymd` here is only a probe for "is this shaped like a date at all";
      // the real order is settled later by detectDateOrder.
      if (parseDate(v, 'dmy') || parseDate(v, 'ymd')) dates++;
      else if (parseAmount(v, '.') != null || parseAmount(v, ',') != null) amounts++;
    }
    const denom = Math.max(filled, 1);
    dateHits.push(dates / denom);
    amountHits.push(amounts / denom);
    textLen.push(filled === 0 ? 0 : chars / filled);
  }

  const claim = (role: ColumnRole, scores: number[], min: number) => {
    let best = -1;
    let bestScore = min;
    scores.forEach((s, i) => {
      if (mapping[i] === 'ignore' && s > bestScore) {
        bestScore = s;
        best = i;
      }
    });
    if (best >= 0) mapping[best] = role;
  };

  claim('date', dateHits, 0.7);
  claim('amount', amountHits, 0.7);
  // Description is whatever text column is longest on average, among columns
  // that are mostly NOT numeric — an account-number column would otherwise win
  // on width alone.
  claim(
    'description',
    textLen.map((len, i) => (amountHits[i] > 0.5 || dateHits[i] > 0.5 ? 0 : len)),
    0,
  );
  return mapping;
}

/** True when the first row looks like labels rather than data — no cell in it
 *  parses as a date or a number, and at least one is non-empty text. */
export function looksLikeHeader(row: string[]): boolean {
  let text = 0;
  for (const cell of row) {
    const v = cell.trim();
    if (!v) continue;
    if (parseAmount(v, '.') != null || parseAmount(v, ',') != null) return false;
    if (/^\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}$/.test(v)) return false;
    text++;
  }
  return text > 0;
}

// ─── Amounts ───────────────────────────────────────────────────────────────

// parseAmount lives in ./parseAmount (v1.17, limecore#12); re-exported so this
// module's importers and tests are unchanged.
export { parseAmount };
export type { DecimalSeparator };

/**
 * Decide whether a column writes `1,234.56` or `1.234,56`.
 *
 * When both separators appear, the last one is the decimal point — that holds
 * for every locale. When only one appears it is genuinely ambiguous in the
 * abstract (`1,234` is a thousand-something or one-point-two-three-four), so we
 * use the grouping rule: a thousands separator is ALWAYS followed by exactly
 * three digits and never ends the number. One counter-example in the column is
 * enough to settle it.
 */
export function detectDecimalSeparator(values: string[]): DecimalSeparator {
  let sawBoth = false;
  let lastWhenBoth: DecimalSeparator = '.';
  let commaIsDecimal = false;
  let dotIsDecimal = false;

  for (const raw of values) {
    const s = (raw ?? '').replace(/[^\d.,]/g, '');
    if (!s) continue;
    const lastDot = s.lastIndexOf('.');
    const lastComma = s.lastIndexOf(',');
    if (lastDot >= 0 && lastComma >= 0) {
      sawBoth = true;
      lastWhenBoth = lastDot > lastComma ? '.' : ',';
      continue;
    }
    if (lastComma >= 0) {
      const after = s.length - lastComma - 1;
      const commas = s.match(/,/g)?.length ?? 0;
      if (commas === 1 && after !== 3) commaIsDecimal = true;
    } else if (lastDot >= 0) {
      const after = s.length - lastDot - 1;
      const dots = s.match(/\./g)?.length ?? 0;
      if (dots === 1 && after !== 3) dotIsDecimal = true;
    }
  }

  if (sawBoth) return lastWhenBoth;
  if (commaIsDecimal && !dotIsDecimal) return ',';
  if (dotIsDecimal && !commaIsDecimal) return '.';
  // Nothing decisive (e.g. every value is a whole number, or the column mixes
  // both conventions and is broken either way) — `.` is the safer default
  // because it leaves `1,234` reading as 1234 rather than 1.234, and a
  // thousand-fold error is more visible to the user than a rounding one.
  return '.';
}

// ─── Dates ─────────────────────────────────────────────────────────────────

export type DateOrder = 'ymd' | 'dmy' | 'mdy';

const MONTH_NAMES: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

interface DateParts {
  a: number;
  b: number;
  c: number;
  /** Year position was unambiguous from a 4-digit component. */
  yearFirst: boolean;
  yearLast: boolean;
  monthName: number | null;
}

function splitDate(raw: string): DateParts | null {
  const s = (raw ?? '').trim();
  if (!s) return null;
  // Strip a trailing time component — plenty of exports carry `2026-08-01 14:32`
  // or a full ISO instant. Matched explicitly rather than by splitting on `T`,
  // which would also cut `Oct` in half.
  const dateOnly = s
    .replace(/[T\s]+\d{1,2}:\d{2}(:\d{2})?(\.\d+)?\s*(Z|[+-]\d{2}:?\d{2})?$/i, '')
    .trim();
  // Whitespace and commas separate too — `05 Jan 2026`, `Jan 5, 2026`.
  const parts = dateOnly.split(/[-/.\s,]+/).filter((p) => p !== '');
  if (parts.length !== 3) return null;

  let monthName: number | null = null;
  const nums: number[] = [];
  for (const p of parts) {
    const asMonth = MONTH_NAMES[p.slice(0, 3).toLowerCase()];
    if (asMonth && !/^\d+$/.test(p)) {
      monthName = asMonth;
      nums.push(-1);
      continue;
    }
    if (!/^\d+$/.test(p)) return null;
    nums.push(Number(p));
  }
  return {
    a: nums[0],
    b: nums[1],
    c: nums[2],
    yearFirst: parts[0].length === 4,
    yearLast: parts[2].length === 4,
    monthName,
  };
}

export interface DateOrderResult {
  order: DateOrder;
  /** True when the sample contains no value that distinguishes day-first from
   *  month-first. The UI must surface a control rather than pretend. */
  ambiguous: boolean;
}

/**
 * Work out the column's date order from the whole column, not one value.
 *
 * `03/04/2026` is undecidable alone. Across a real statement it usually is not:
 * one row with a first component above 12 proves day-first, one with a second
 * component above 12 proves month-first. When neither appears — a short export
 * that happens to sit entirely in the first twelve days of each month — we say
 * so and default to day-first, which is the majority convention worldwide and
 * matches this app's locale spread.
 */
export function detectDateOrder(values: string[]): DateOrderResult {
  let iso = 0;
  let dayFirstProof = 0;
  let monthFirstProof = 0;
  let usable = 0;

  for (const raw of values) {
    const p = splitDate(raw);
    if (!p) continue;
    usable++;
    if (p.yearFirst) {
      iso++;
      continue;
    }
    if (p.monthName != null) continue; // month name settles itself per-row
    if (p.a > 12 && p.a <= 31) dayFirstProof++;
    if (p.b > 12 && p.b <= 31) monthFirstProof++;
  }

  if (usable === 0) return { order: 'dmy', ambiguous: true };
  if (iso / usable > 0.5) return { order: 'ymd', ambiguous: false };
  if (dayFirstProof > monthFirstProof) return { order: 'dmy', ambiguous: false };
  if (monthFirstProof > dayFirstProof) return { order: 'mdy', ambiguous: false };
  return { order: 'dmy', ambiguous: true };
}

/** Parse one cell to `YYYY-MM-DD`, or null if it is not a date under `order`.
 *  Calendar-validated, so `31/02/2026` is rejected rather than rolled forward
 *  into March — a silently-shifted date is worse than a visible failure. */
export function parseDate(raw: string, order: DateOrder): string | null {
  const p = splitDate(raw);
  if (!p) return null;

  let y: number;
  let m: number;
  let d: number;

  if (p.monthName != null) {
    m = p.monthName;
    // `05 Jan 2026` or `Jan 05 2026` — the year is the 4-digit part, the day is
    // whatever numeric component is left.
    const nums = [p.a, p.b, p.c].filter((n) => n >= 0);
    if (nums.length !== 2) return null;
    if (p.yearLast) {
      y = p.c;
      d = nums[0] === p.c ? nums[1] : nums[0];
    } else if (p.yearFirst) {
      y = p.a;
      d = nums[1];
    } else {
      return null;
    }
  } else if (p.yearFirst || order === 'ymd') {
    y = p.a;
    m = p.b;
    d = p.c;
  } else if (order === 'mdy') {
    m = p.a;
    d = p.b;
    y = p.c;
  } else {
    d = p.a;
    m = p.b;
    y = p.c;
  }

  if (y < 100) y += y < 70 ? 2000 : 1900; // two-digit years still exist
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  // Reject impossible calendar days rather than letting Date roll them over.
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) {
    return null;
  }
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// ─── Row building ──────────────────────────────────────────────────────────

export type RowProblem = 'date' | 'amount' | 'description';

export type DuplicateKind = 'existing' | 'file';

export interface ImportRow {
  /** 1-based line number within the data rows, for error reporting. */
  line: number;
  raw: string[];
  date: string | null;
  description: string;
  /** Positive magnitude. Direction lives in `type`, matching how the app
   *  stores every transaction. */
  amount: number | null;
  type: TransactionType;
  categoryName: string | null;
  notes: string | null;
  problems: RowProblem[];
  duplicate: DuplicateKind | null;
  /** User's decision. Rows with problems can never be selected. */
  selected: boolean;
}

export interface BuildOptions {
  rows: string[][];
  mapping: ColumnMapping;
  dateOrder: DateOrder;
  decimal: DecimalSeparator;
  /** Flip the sign convention: some exports write expenses as positive. Only
   *  meaningful in single-amount mode. */
  invertSign: boolean;
  /** Existing transactions to dedup against, already narrowed to the target
   *  account by the caller. */
  existing: Transaction[];
}

/** Normalised dedup key. Description is case-folded and stripped of
 *  punctuation and runs of whitespace, because the same merchant comes back
 *  from a bank with different spacing between two exports. */
export function dedupKey(date: string, amount: number, description: string): string {
  const desc = description
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  return `${date}|${amount.toFixed(2)}|${desc}`;
}

function firstIndex(mapping: ColumnMapping, role: ColumnRole): number {
  return mapping.indexOf(role);
}

function cell(row: string[], idx: number): string {
  return idx >= 0 && idx < row.length ? (row[idx] ?? '').trim() : '';
}

/**
 * Turn parsed cells into candidate transactions with per-row diagnostics.
 *
 * Rows that cannot be imported are KEPT, flagged, and rendered — a silent drop
 * is the failure mode that makes a user trust an import that only brought in
 * half their statement.
 */
export function buildRows({
  rows,
  mapping,
  dateOrder,
  decimal,
  invertSign,
  existing,
}: BuildOptions): ImportRow[] {
  const iDate = firstIndex(mapping, 'date');
  const iDesc = firstIndex(mapping, 'description');
  const iAmount = firstIndex(mapping, 'amount');
  const iDebit = firstIndex(mapping, 'debit');
  const iCredit = firstIndex(mapping, 'credit');
  const iCat = firstIndex(mapping, 'category');
  const iNotes = firstIndex(mapping, 'notes');
  const pairMode = iDebit >= 0 || iCredit >= 0;

  const existingKeys = new Set<string>();
  for (const tx of existing) {
    if (tx.type === 'transfer') continue;
    existingKeys.add(dedupKey(tx.date, Math.abs(tx.amount), tx.description ?? ''));
  }
  const seenInFile = new Set<string>();

  return rows.map((raw, n) => {
    const problems: RowProblem[] = [];
    const date = parseDate(cell(raw, iDate), dateOrder);
    if (!date) problems.push('date');

    let signed: number | null = null;
    if (pairMode) {
      const debit = parseAmount(cell(raw, iDebit), decimal);
      const credit = parseAmount(cell(raw, iCredit), decimal);
      // Exactly one of the pair carries a figure on a well-formed row. When
      // both do, the larger wins and the row is left importable rather than
      // rejected — banks do emit zero-filled companion columns.
      const d = debit != null && debit !== 0 ? Math.abs(debit) : null;
      const c = credit != null && credit !== 0 ? Math.abs(credit) : null;
      if (d != null && c != null) signed = d >= c ? -d : c;
      else if (d != null) signed = -d;
      else if (c != null) signed = c;
    } else {
      const v = parseAmount(cell(raw, iAmount), decimal);
      if (v != null) signed = invertSign ? -v : v;
    }
    if (signed == null || signed === 0) problems.push('amount');

    const description = cell(raw, iDesc);
    if (!description) problems.push('description');

    const amount = signed == null ? null : Math.abs(signed);
    const type: TransactionType = (signed ?? 0) >= 0 ? 'income' : 'expense';

    let duplicate: DuplicateKind | null = null;
    if (date && amount != null) {
      const key = dedupKey(date, amount, description);
      if (existingKeys.has(key)) duplicate = 'existing';
      else if (seenInFile.has(key)) duplicate = 'file';
      seenInFile.add(key);
    }

    const categoryName = iCat >= 0 ? cell(raw, iCat) || null : null;
    const notes = iNotes >= 0 ? cell(raw, iNotes) || null : null;

    return {
      line: n + 1,
      raw,
      date,
      description,
      amount,
      type,
      categoryName,
      notes,
      problems,
      duplicate,
      // Importable rows default in; duplicates default OUT but stay togglable,
      // because two identical coffees on one day is a real thing and only the
      // user knows which it was.
      selected: problems.length === 0 && duplicate === null,
    };
  });
}

export interface ImportSummary {
  total: number;
  importable: number;
  duplicates: number;
  problems: number;
  selected: number;
}

export function summarise(rows: ImportRow[]): ImportSummary {
  let importable = 0;
  let duplicates = 0;
  let problems = 0;
  let selected = 0;
  for (const r of rows) {
    if (r.problems.length > 0) problems++;
    else importable++;
    if (r.duplicate) duplicates++;
    if (r.selected) selected++;
  }
  return { total: rows.length, importable, duplicates, problems, selected };
}

// ─── Export ────────────────────────────────────────────────────────────────

/** Quote a cell only when it needs it, so the common case stays readable in a
 *  text editor. */
function csvCell(value: string): string {
  // v1.22 (limecore#99): a text cell that starts like a formula runs as one in
  // Excel or Sheets, and a payee name from an imported statement is enough.
  // The leading apostrophe is the spreadsheet convention for "this is text".
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/**
 * The round-trip: what this writes, `parseDelimited` + `guessMapping` read back
 * without any manual mapping. Deliberately ISO dates and `.` decimals — this is
 * our format, so it is the unambiguous one.
 */
export function toCsv(
  transactions: Transaction[],
  categoryName: (id: string | undefined) => string,
): string {
  const header = ['Date', 'Description', 'Amount', 'Category', 'Notes'];
  const lines = [header.join(',')];
  for (const tx of transactions) {
    const signed = tx.type === 'expense' ? -Math.abs(tx.amount) : Math.abs(tx.amount);
    lines.push(
      [
        tx.date,
        csvCell(tx.description ?? ''),
        signed.toFixed(2),
        csvCell(categoryName(tx.categoryId)),
        csvCell(tx.notes ?? ''),
      ].join(','),
    );
  }
  return lines.join('\n');
}

/**
 * v1.22 (NCC#254) — a statement's amounts are in its account's currency, and
 * a transaction's are in the base currency (lib/accountBalance.ts converts
 * them back for the account at read time). Import into an account in another
 * currency converts each amount to the base. Null when any amount has no
 * rate: then nothing is imported, rather than some rows in the wrong currency.
 */
export function amountsInBase(
  amounts: number[],
  accountCurrency: string,
  baseCurrency: string,
  convert: (amount: number, from: string, to: string) => number | null,
): number[] | null {
  if (accountCurrency === baseCurrency) return amounts;
  const out: number[] = [];
  for (const a of amounts) {
    const v = convert(a, accountCurrency, baseCurrency);
    if (v == null || !Number.isFinite(v)) return null;
    out.push(Math.round(v * 100) / 100);
  }
  return out;
}
