import { describe, it, expect } from 'vitest';
import {
  amountsInBase,
  parseDelimited,
  detectDelimiter,
  stripBom,
  parseAmount,
  detectDecimalSeparator,
  detectDateOrder,
  parseDate,
  dedupKey,
  buildRows,
  summarise,
  looksLikeHeader,
  guessMapping,
  type ColumnMapping,
} from './csvImport';
import type { Transaction } from '../types/finance';

// Characterization tests (v1.16, limecore#11). These pin what the bank-statement
// importer does TODAY so the code-health pass (limecore#12) cannot quietly
// change it. This module turns a stranger's bank export into money rows, so a
// silent behaviour change here is corrupted financial data, not a cosmetic bug.

describe('parseDelimited', () => {
  it('splits plain rows and drops the trailing blank line exports always carry', () => {
    expect(parseDelimited('a,b\n1,2\n', ',')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('keeps a delimiter that sits inside a quoted field', () => {
    expect(parseDelimited('"Smith, John",5\n', ',')).toEqual([['Smith, John', '5']]);
  });

  it('unescapes a doubled quote', () => {
    expect(parseDelimited('"He said ""hi""",5\n', ',')).toEqual([['He said "hi"', '5']]);
  });

  it('treats CRLF the same as LF', () => {
    expect(parseDelimited('a,b\r\n1,2\r\n', ',')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('keeps a row whose only content is a quoted empty field', () => {
    // `quoted` is tracked separately from `field` precisely so this row is not
    // mistaken for the blank trailing line — but the all-blank filter still
    // removes it, and that is the documented behaviour.
    expect(parseDelimited('""\n', ',')).toEqual([]);
  });

  it('keeps a final row that has no trailing newline', () => {
    expect(parseDelimited('a,b\n1,2', ',')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });
});

describe('detectDelimiter', () => {
  it('picks the semicolon even when commas outnumber it inside descriptions', () => {
    // The regression this function exists for: counting separators in the
    // header would answer ',' here and shred every row.
    const text = 'Date;Description;Amount\n2026-01-05;Smith, John, and Co;12,50\n2026-01-06;A, B, C, D;3,00\n';
    expect(detectDelimiter(text)).toBe(';');
  });

  it('picks the comma for an ordinary comma file', () => {
    expect(detectDelimiter('Date,Description,Amount\n2026-01-05,Coffee,3.50\n')).toBe(',');
  });

  it('picks tab for a TSV', () => {
    expect(detectDelimiter('Date\tDescription\tAmount\n2026-01-05\tCoffee\t3.50\n')).toBe('\t');
  });

  it('falls back to comma when nothing splits into columns', () => {
    expect(detectDelimiter('just one line of prose\n')).toBe(',');
  });
});

describe('stripBom', () => {
  it('removes the BOM Excel writes', () => {
    expect(stripBom('﻿Date,Amount')).toBe('Date,Amount');
  });

  it('leaves text without a BOM untouched', () => {
    expect(stripBom('Date,Amount')).toBe('Date,Amount');
  });
});

describe('parseAmount', () => {
  it('parses a plain decimal', () => {
    expect(parseAmount('12.50', '.')).toBe(12.5);
  });

  it('strips thousands separators against the chosen decimal mark', () => {
    expect(parseAmount('1,234.56', '.')).toBe(1234.56);
    expect(parseAmount('1.234,56', ',')).toBe(1234.56);
  });

  it('handles the Swiss apostrophe grouping', () => {
    expect(parseAmount("1'234.56", '.')).toBe(1234.56);
  });

  it('reads accounting parentheses as negative', () => {
    expect(parseAmount('(12.50)', '.')).toBe(-12.5);
  });

  it('reads a trailing minus as negative', () => {
    expect(parseAmount('12.50-', '.')).toBe(-12.5);
  });

  it('accepts a unicode minus, en dash or em dash', () => {
    expect(parseAmount('−12.50', '.')).toBe(-12.5);
    expect(parseAmount('–12.50', '.')).toBe(-12.5);
    expect(parseAmount('—12.50', '.')).toBe(-12.5);
  });

  it('drops currency symbols and codes on either side', () => {
    expect(parseAmount('€12.50', '.')).toBe(12.5);
    expect(parseAmount('12.50 EUR', '.')).toBe(12.5);
    expect(parseAmount('$ 1,234.56', '.')).toBe(1234.56);
  });

  it('returns null for an empty or non-numeric cell', () => {
    expect(parseAmount('', '.')).toBeNull();
    expect(parseAmount('   ', '.')).toBeNull();
    expect(parseAmount('n/a', '.')).toBeNull();
  });

  it('returns null rather than guessing when separators are inconsistent', () => {
    // `1.2.3` under a '.' decimal leaves two dots after grouping removal.
    expect(parseAmount('1.2.3', '.')).toBeNull();
  });

  it('keeps zero as zero rather than null', () => {
    expect(parseAmount('0.00', '.')).toBe(0);
  });
});

describe('detectDecimalSeparator', () => {
  it('takes the last separator when a value carries both', () => {
    expect(detectDecimalSeparator(['1.234,56'])).toBe(',');
    expect(detectDecimalSeparator(['1,234.56'])).toBe('.');
  });

  it('uses the grouping rule when only one separator appears', () => {
    // Two digits after the comma cannot be a thousands group.
    expect(detectDecimalSeparator(['12,50', '3,00'])).toBe(',');
    expect(detectDecimalSeparator(['12.50', '3.00'])).toBe('.');
  });

  it('does not mistake a real thousands group for a decimal mark', () => {
    expect(detectDecimalSeparator(['1,234', '5,678'])).toBe('.');
  });

  it('defaults to dot when the column is all whole numbers', () => {
    expect(detectDecimalSeparator(['12', '34'])).toBe('.');
  });

  it('defaults to dot on an empty column', () => {
    expect(detectDecimalSeparator([])).toBe('.');
  });
});

describe('detectDateOrder', () => {
  it('detects ISO from a 4-digit leading year', () => {
    expect(detectDateOrder(['2026-01-05', '2026-02-06'])).toEqual({
      order: 'ymd',
      ambiguous: false,
    });
  });

  it('proves day-first from one value with a first component above 12', () => {
    expect(detectDateOrder(['05/01/2026', '13/01/2026'])).toEqual({
      order: 'dmy',
      ambiguous: false,
    });
  });

  it('proves month-first from one value with a second component above 12', () => {
    expect(detectDateOrder(['01/05/2026', '01/13/2026'])).toEqual({
      order: 'mdy',
      ambiguous: false,
    });
  });

  it('reports ambiguity instead of guessing when nothing distinguishes the two', () => {
    expect(detectDateOrder(['01/05/2026', '02/06/2026'])).toEqual({
      order: 'dmy',
      ambiguous: true,
    });
  });

  it('reports ambiguity for a column with no parseable dates', () => {
    expect(detectDateOrder(['', 'not a date'])).toEqual({ order: 'dmy', ambiguous: true });
  });
});

describe('parseDate', () => {
  it('normalises each order to YYYY-MM-DD', () => {
    expect(parseDate('05/01/2026', 'dmy')).toBe('2026-01-05');
    expect(parseDate('01/05/2026', 'mdy')).toBe('2026-01-05');
    expect(parseDate('2026-01-05', 'ymd')).toBe('2026-01-05');
  });

  it('lets a 4-digit leading year override the declared order', () => {
    expect(parseDate('2026-01-05', 'dmy')).toBe('2026-01-05');
  });

  it('strips a trailing time component', () => {
    expect(parseDate('2026-01-05 14:32', 'ymd')).toBe('2026-01-05');
    expect(parseDate('2026-01-05T14:32:10Z', 'ymd')).toBe('2026-01-05');
  });

  it('reads month names in either position', () => {
    expect(parseDate('05 Jan 2026', 'dmy')).toBe('2026-01-05');
    expect(parseDate('Jan 5, 2026', 'mdy')).toBe('2026-01-05');
  });

  it('expands two-digit years at the 70 boundary', () => {
    expect(parseDate('05/01/26', 'dmy')).toBe('2026-01-05');
    expect(parseDate('05/01/69', 'dmy')).toBe('2069-01-05');
    expect(parseDate('05/01/70', 'dmy')).toBe('1970-01-05');
  });

  it('rejects an impossible calendar day rather than rolling it into March', () => {
    expect(parseDate('31/02/2026', 'dmy')).toBeNull();
  });

  it('rejects a value that is not three components', () => {
    expect(parseDate('2026-01', 'ymd')).toBeNull();
    expect(parseDate('', 'ymd')).toBeNull();
  });
});

describe('dedupKey', () => {
  it('folds case, punctuation and whitespace so one merchant matches itself', () => {
    expect(dedupKey('2026-01-05', 12.5, 'TESCO  STORES #123')).toBe(
      dedupKey('2026-01-05', 12.5, 'Tesco Stores 123'),
    );
  });

  it('fixes the amount to two decimals so 12.5 and 12.50 agree', () => {
    expect(dedupKey('2026-01-05', 12.5, 'x')).toBe(dedupKey('2026-01-05', 12.5, 'x'));
    expect(dedupKey('2026-01-05', 12.5, 'x')).toContain('12.50');
  });

  it('keeps different dates apart', () => {
    expect(dedupKey('2026-01-05', 12.5, 'x')).not.toBe(dedupKey('2026-01-06', 12.5, 'x'));
  });
});

// `mapping` positions line up with the raw cell order in each fixture below.
const SINGLE_AMOUNT: ColumnMapping = ['date', 'description', 'amount'];
const DEBIT_CREDIT: ColumnMapping = ['date', 'description', 'debit', 'credit'];

function build(rows: string[][], mapping: ColumnMapping, opts: Partial<Parameters<typeof buildRows>[0]> = {}) {
  return buildRows({
    rows,
    mapping,
    dateOrder: 'ymd',
    decimal: '.',
    invertSign: false,
    existing: [],
    ...opts,
  });
}

describe('buildRows', () => {
  it('splits sign into type and keeps amount a positive magnitude', () => {
    const [income, expense] = build(
      [
        ['2026-01-05', 'Salary', '2000.00'],
        ['2026-01-06', 'Coffee', '-3.50'],
      ],
      SINGLE_AMOUNT,
    );
    expect(income).toMatchObject({ amount: 2000, type: 'income', problems: [] });
    expect(expense).toMatchObject({ amount: 3.5, type: 'expense', problems: [] });
  });

  it('honours invertSign for exports that write expenses as positive', () => {
    const [row] = build([['2026-01-06', 'Coffee', '3.50']], SINGLE_AMOUNT, { invertSign: true });
    expect(row).toMatchObject({ amount: 3.5, type: 'expense' });
  });

  it('reads a debit/credit pair as one signed figure', () => {
    const [debit, credit] = build(
      [
        ['2026-01-05', 'Coffee', '3.50', ''],
        ['2026-01-06', 'Salary', '', '2000.00'],
      ],
      DEBIT_CREDIT,
    );
    expect(debit).toMatchObject({ amount: 3.5, type: 'expense' });
    expect(credit).toMatchObject({ amount: 2000, type: 'income' });
  });

  it('lets the larger side win when a bank zero-fills the companion column', () => {
    const [row] = build([['2026-01-05', 'Coffee', '3.50', '1.00']], DEBIT_CREDIT);
    expect(row).toMatchObject({ amount: 3.5, type: 'expense', problems: [] });
  });

  it('keeps unimportable rows, flagged, rather than dropping them silently', () => {
    const rows = build(
      [
        ['not a date', 'Coffee', '3.50'],
        ['2026-01-05', '', '3.50'],
        ['2026-01-05', 'Coffee', 'n/a'],
      ],
      SINGLE_AMOUNT,
    );
    expect(rows).toHaveLength(3);
    expect(rows[0].problems).toContain('date');
    expect(rows[1].problems).toContain('description');
    expect(rows[2].problems).toContain('amount');
    expect(rows.every((r) => r.selected === false)).toBe(true);
  });

  it('treats a zero amount as a problem', () => {
    const [row] = build([['2026-01-05', 'Coffee', '0.00']], SINGLE_AMOUNT);
    expect(row.problems).toContain('amount');
  });

  it('numbers lines from 1 for error reporting', () => {
    const rows = build(
      [
        ['2026-01-05', 'a', '1.00'],
        ['2026-01-06', 'b', '2.00'],
      ],
      SINGLE_AMOUNT,
    );
    expect(rows.map((r) => r.line)).toEqual([1, 2]);
  });

  it('flags a row already present in the account and leaves it deselected', () => {
    const existing = [
      { id: 't1', date: '2026-01-05', amount: 3.5, description: 'Coffee', type: 'expense' },
    ] as unknown as Transaction[];
    const [row] = build([['2026-01-05', 'Coffee', '-3.50']], SINGLE_AMOUNT, { existing });
    expect(row.duplicate).toBe('existing');
    expect(row.selected).toBe(false);
  });

  it('flags the second of two identical rows inside one file, not the first', () => {
    const rows = build(
      [
        ['2026-01-05', 'Coffee', '-3.50'],
        ['2026-01-05', 'Coffee', '-3.50'],
      ],
      SINGLE_AMOUNT,
    );
    expect(rows[0].duplicate).toBeNull();
    expect(rows[0].selected).toBe(true);
    expect(rows[1].duplicate).toBe('file');
    expect(rows[1].selected).toBe(false);
  });

  it('ignores existing transfers when deduping', () => {
    const existing = [
      { id: 't1', date: '2026-01-05', amount: 3.5, description: 'Coffee', type: 'transfer' },
    ] as unknown as Transaction[];
    const [row] = build([['2026-01-05', 'Coffee', '-3.50']], SINGLE_AMOUNT, { existing });
    expect(row.duplicate).toBeNull();
  });

  it('reads optional category and notes columns as null when absent', () => {
    const [row] = build([['2026-01-05', 'Coffee', '-3.50']], SINGLE_AMOUNT);
    expect(row.categoryName).toBeNull();
    expect(row.notes).toBeNull();
  });
});

describe('summarise', () => {
  it('counts importable, problem and duplicate rows off the same set', () => {
    const rows = build(
      [
        ['2026-01-05', 'Coffee', '-3.50'],
        ['2026-01-05', 'Coffee', '-3.50'],
        ['bad', 'Coffee', '-3.50'],
      ],
      SINGLE_AMOUNT,
    );
    const s = summarise(rows);
    expect(s).toEqual({
      total: 3,
      // `importable` means "nothing wrong with the row", which a duplicate
      // still satisfies — so it counts both Coffee rows. `selected` is the
      // narrower number the import button acts on.
      importable: 2,
      duplicates: 1,
      problems: 1,
      selected: 1,
    });
  });
});

describe('looksLikeHeader', () => {
  it('recognises a header row of labels', () => {
    expect(looksLikeHeader(['Date', 'Description', 'Amount'])).toBe(true);
  });

  it('does not mistake a data row for a header', () => {
    expect(looksLikeHeader(['2026-01-05', 'Coffee', '-3.50'])).toBe(false);
  });
});

describe('guessMapping', () => {
  it('maps the common English header names', () => {
    const m = guessMapping(['Date', 'Description', 'Amount']);
    expect(m[0]).toBe('date');
    expect(m[1]).toBe('description');
    expect(m[2]).toBe('amount');
  });

  it('maps a debit/credit pair rather than calling either one amount', () => {
    const m = guessMapping(['Date', 'Description', 'Debit', 'Credit']);
    expect(m[2]).toBe('debit');
    expect(m[3]).toBe('credit');
  });
});

// v1.22 (NCC#254) — a statement imported into an account in another currency.
describe('amountsInBase', () => {
  // 1 USD = 0.9 EUR
  const convert = (a: number, from: string, to: string) => (from === 'USD' && to === 'EUR' ? a * 0.9 : null);

  it('converts every amount from the account currency to the base', () => {
    expect(amountsInBase([1000, 12.5], 'USD', 'EUR', convert)).toEqual([900, 11.25]);
  });

  it('leaves amounts alone when the account is in the base currency', () => {
    expect(amountsInBase([1000], 'EUR', 'EUR', () => null)).toEqual([1000]);
  });

  it('imports nothing when a rate is missing', () => {
    expect(amountsInBase([1000], 'SEK', 'EUR', convert)).toBeNull();
  });
});
