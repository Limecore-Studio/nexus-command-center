import { describe, it, expect, vi } from 'vitest';

vi.mock('./supabase', () => ({ supabase: {} }));
const { computeTotalBase } = await import('./portfolioTotal');

// v1.22 (NCC#263) — the day's snapshot is written only when every holding has
// a price, so a failed fetch cannot record a partial total as the day's value.

const stock = (ticker: string, quantity: number) => ({ id: ticker, ticker, quantity, assetType: 'stock' }) as any;
const quote = (ticker: string, c: number) => ({ ticker, currency: 'EUR', quote: { c } }) as any;

describe('computeTotalBase', () => {
  it('counts holdings it could not price', () => {
    const r = computeTotalBase([stock('A', 10), stock('B', 5)], [quote('A', 100)], null, { EUR: 1 }, 'EUR');
    expect(r).toEqual({ total: 1000, unpriced: 1 });
  });

  it('reports none unpriced when every holding has a quote', () => {
    const r = computeTotalBase([stock('A', 10), stock('B', 5)], [quote('A', 100), quote('B', 20)], null, { EUR: 1 }, 'EUR');
    expect(r).toEqual({ total: 1100, unpriced: 0 });
  });
});
