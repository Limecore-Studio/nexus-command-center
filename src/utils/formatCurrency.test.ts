import { describe, it, expect } from 'vitest';
import { formatCurrency } from './formatters';

// v1.20 (NCC#224): the home budget showed euros to a user on INR, because
// formatCurrency defaulted to 'EUR' and three screens left the currency out.
describe('formatCurrency (NCC#224)', () => {
  it('renders the currency it is given', () => {
    expect(formatCurrency(1234.5, 'INR')).toContain('₹');
    expect(formatCurrency(1234.5, 'USD')).toContain('$');
    expect(formatCurrency(1234.5, 'INR')).not.toContain('€');
  });

  it('has no default currency to fall back on', () => {
    // The compiler is the gate: `tsc -b` (part of `npm run build`) fails on a
    // call without one, and this line proves it still does.
    // @ts-expect-error currency is required
    expect(() => formatCurrency(1)).toThrow();
  });
});
