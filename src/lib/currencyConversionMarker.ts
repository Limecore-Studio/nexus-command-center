// v1.21 (NCC#266): a base-currency conversion is three steps that cannot share
// one transaction: the account claim (server), the device setting, and the
// row rewrite (Dexie). This marker is written before the first step and
// cleared after the last. While it is present, nothing is pushed or pulled:
// a sync must first finish or undo the conversion (resolvePendingConversion
// in baseCurrencyCloud.ts, loaded on demand).
//
// Kept tiny and synchronous because the sync store imports it at startup.
const KEY = 'ncc.currencyConversion';

/** One converted row, to tell afterwards whether the rewrite committed. */
export interface ConversionProbe {
  table: 'transactions' | 'budgetCategories' | 'recurringRules';
  id: string;
  original: number;
  converted: number;
}

export interface ConversionMarker {
  from: string;
  to: string;
  userId: string | null;
  /** The account claim went through, so undoing means claiming back. */
  claimed: boolean;
  probe: ConversionProbe | null;
}

/** The startup check: is a conversion unresolved? */
export function conversionPending(): boolean {
  try {
    return localStorage.getItem(KEY) !== null;
  } catch {
    return false;
  }
}

export function readConversionMarker(): ConversionMarker | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as ConversionMarker) : null;
  } catch {
    return null;
  }
}

export function writeConversionMarker(m: ConversionMarker): void {
  localStorage.setItem(KEY, JSON.stringify(m));
}

export function clearConversionMarker(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing to clear */
  }
}
