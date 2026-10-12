// v1.9 Item 14b #9 — keyboard-driven transaction entry.
//
// "Quick-add with autocomplete for daily power users" means one line of typing
// and Enter, with no pointer and no tab order to walk. The grammar is the
// familiar one from note-taking tools rather than an invented syntax:
//
//   12.50 coffee #food @checking
//   +2500 salary #income @checking
//   9,80 lunch #food yesterday
//
// Everything is optional except the amount. Tokens can appear in any order,
// because the point is to type the way you think rather than fill a form in
// field order.
//
// The parser is pure and knows nothing about the store: it returns TOKENS
// (the raw text after `#` and `@`), and resolution against real categories and
// accounts happens separately via `rankMatches`. That split is what lets the
// overlay show live suggestions for a half-typed token — there is no such thing
// as a "partially parsed" state to special-case.

import { numberInput } from './numberInput';

export interface QuickEntryDraft {
  /** Positive magnitude. Direction is in `type`, as everywhere else. */
  amount: number | null;
  description: string;
  type: 'expense' | 'income';
  /** Raw text after `#`, possibly a prefix the user is still typing. */
  categoryToken: string | null;
  /** Raw text after `@`. */
  accountToken: string | null;
  /** `YYYY-MM-DD`, already resolved from `today` / `yesterday` / an ISO date. */
  date: string;
  /** Which token the caret is inside, so the caller knows what to suggest. */
  active: 'category' | 'account' | null;
}

function shiftDays(today: string, days: number): string {
  const [y, m, d] = today.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

/**
 * Amount parsing for TYPED input, which is narrower than the CSV case: the
 * user types one number, so a lone separator with one or two digits after it
 * is a decimal point in any locale. Goes through `numberInput` (and so
 * `parseAmount`) rather than carrying a second implementation.
 */
function typedAmount(token: string): number | null {
  // v1.18.1 (NCC#144): the same rules as every other money field
  // (numberInput). This read "1.234,56" as 1.23456.
  const n = numberInput(token);
  return Number.isNaN(n) ? null : n;
}

/** A token is an amount only if it is mostly digits — `#food` and `2for1`
 *  should not be swallowed as the amount just because a number is in there. */
/* eslint-disable no-irregular-whitespace -- the character classes below intentionally include a non-breaking space, a real thousands-separator in several supported locales */
function looksNumeric(token: string): boolean {
  return /^[+-]?[\d.,\s' ]*\d[\d.,\s' ]*$/.test(token.replace(/^[€$£¥]|[€$£¥]$/g, ''));
}

/* eslint-enable no-irregular-whitespace */

export function parseQuickEntry(
  input: string,
  today: string,
  /** Caret position, used only to decide which token is "active". Defaults to
   *  end of input, which is where it is while typing. */
  caret: number = input.length,
): QuickEntryDraft {
  const draft: QuickEntryDraft = {
    amount: null,
    description: '',
    type: 'expense',
    categoryToken: null,
    accountToken: null,
    date: today,
    active: null,
  };

  const words: string[] = [];
  let cursor = 0;
  for (const raw of input.split(/(\s+)/)) {
    const start = cursor;
    cursor += raw.length;
    const token = raw.trim();
    if (!token) continue;
    const caretInside = caret > start && caret <= start + raw.length;

    if (token.startsWith('#')) {
      draft.categoryToken = token.slice(1);
      if (caretInside) draft.active = 'category';
      continue;
    }
    if (token.startsWith('@')) {
      draft.accountToken = token.slice(1);
      if (caretInside) draft.active = 'account';
      continue;
    }
    const lower = token.toLowerCase();
    if (lower === 'today') {
      draft.date = today;
      continue;
    }
    if (lower === 'yesterday') {
      draft.date = shiftDays(today, -1);
      continue;
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(token)) {
      draft.date = token;
      continue;
    }
    // First numeric token wins. A later one is part of the description — "2
    // coffees" should not silently overwrite the amount the user already typed.
    if (draft.amount == null && looksNumeric(token)) {
      const v = typedAmount(token);
      if (v != null && v !== 0) {
        // A leading `+` is the only income marker. Bare positive numbers stay
        // expenses because that is what most entries are, and a rule that
        // guesses direction from magnitude would be worse than no rule.
        if (token.startsWith('+')) draft.type = 'income';
        draft.amount = Math.abs(v);
        continue;
      }
    }
    words.push(token);
  }

  draft.description = words.join(' ');
  return draft;
}

export interface Ranked<T> {
  item: T;
  /** Lower is better. Exposed so a caller can style an exact match. */
  score: number;
}

/**
 * Prefix-first fuzzy match. Deliberately not a full fuzzy scorer: with a
 * handful of categories, "starts with what I typed" is what a user expects and
 * a subsequence matcher mostly produces surprising hits. Word-boundary matches
 * rank above mid-word ones so `car` finds "Car insurance" before "Childcare".
 */
export function rankMatches<T>(query: string, items: T[], nameOf: (t: T) => string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  const scored: Ranked<T>[] = [];
  for (const item of items) {
    const name = nameOf(item).toLowerCase();
    if (name === q) scored.push({ item, score: 0 });
    else if (name.startsWith(q)) scored.push({ item, score: 1 });
    else if (name.split(/[^\p{L}\p{N}]+/u).some((w) => w.startsWith(q))) scored.push({ item, score: 2 });
    else if (name.includes(q)) scored.push({ item, score: 3 });
  }
  return scored.sort((a, b) => a.score - b.score).map((s) => s.item);
}

/** True when the draft carries enough to write a transaction. Description is
 *  required because an untitled amount is unreadable a week later. */
export function isComplete(draft: QuickEntryDraft): boolean {
  return draft.amount != null && draft.amount > 0 && draft.description.trim().length > 0;
}
