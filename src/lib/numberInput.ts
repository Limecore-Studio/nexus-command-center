// v1.18.1 (NCC#144) — what a person typed into a number field, as a number.
//
// The money and quantity fields used parseFloat, which stops at the first
// character it does not know: "12,50" saved as 12 and "1.234,56" as 1.234,
// silently. A decimal comma is what anyone using fi, de, fr, es, pt or id
// types, and what many desktop keyboards produce.
//
// Rules, for one typed value (not a CSV cell — see parseAmount):
//   - Both "." and "," present: the LAST one is the decimal separator
//     ("1.234,56" and "1,234.56" are both 1234.56).
//   - One kind, appearing more than once: it groups thousands ("1.234.567").
//   - One kind, once: always the decimal separator ("12,5" and "12.5" are
//     both 12.5; "1.500" is 1.5, "0.125" is 0.125).
// There is deliberately no guess that a lone "1.500" means 1500 in a locale
// that writes decimals with a comma: edit forms prefill stored values with
// String(n), which always writes a dot, so such a guess turned a stored
// 0.125 or 1.125 into 125 or 1125 on save without the user touching it.
// A value in exponent notation (String(9e-7) is "9e-7") is read as written.
// Returns NaN for an empty or unreadable value, as parseFloat did, so call
// sites keep their existing NaN / `> 0` checks.
import { parseAmount, type DecimalSeparator } from './parseAmount';

const EXPONENT = /^[+-]?(\d+\.?\d*|\.\d+)e[+-]?\d+$/i;

export function numberInput(raw: string | null | undefined): number {
  const s = (raw ?? '').trim();
  if (!s) return NaN;
  if (EXPONENT.test(s)) return Number(s);
  const commas = (s.match(/,/g) ?? []).length;
  const dots = (s.match(/\./g) ?? []).length;
  let decimal: DecimalSeparator;
  if (commas > 0 && dots > 0) decimal = s.lastIndexOf(',') > s.lastIndexOf('.') ? ',' : '.';
  else if (commas > 1) decimal = '.';
  else if (dots > 1) decimal = ',';
  else decimal = commas === 1 ? ',' : '.';
  const n = parseAmount(s, decimal);
  return n === null ? NaN : n;
}
