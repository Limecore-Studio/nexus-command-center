import { describe, it, expect } from 'vitest';
import { computeDividendCredits } from './dividendRealize';
import { legacyIdToUuid } from '../utils/uuid';

// v1.18.1 (NCC#152) — a dividend credit's id was the hash of
// "div:TICKER:exDate" alone, the same for every user holding that ticker.
// portfolio_cash_entries has its primary key on id, so the second user's
// credit hit the first user's row (hidden by RLS), was refused and dropped.

const NOW = Date.UTC(2026, 9, 12, 12);
const holding = { id: 'h1', ticker: 'aapl', name: 'Apple', assetType: 'stock', quantity: 10, createdAt: 'x' } as any;
const dividends = { AAPL: [{ date: '2026-10-05', payDate: '2026-10-10', amount: 0.25, currency: 'USD' }] } as any;

// The anchor (first-run date) lives in localStorage; set it before the dividend.
localStorage.setItem('nexus.dividendRealize.anchor.v1', '2026-01-01');

describe('dividend credit ids (NCC#152)', () => {
  it('differ between users for the same ticker and date', () => {
    const a = computeDividendCredits([holding], dividends, [], NOW, 'user-a');
    const b = computeDividendCredits([holding], dividends, [], NOW, 'user-b');
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0].id).not.toBe(b[0].id);
    expect(a[0].relatedId).toBe('div:AAPL:2026-10-05');
  });

  it('are the same on two devices of one account', () => {
    const d1 = computeDividendCredits([holding], dividends, [], NOW, 'user-a');
    const d2 = computeDividendCredits([holding], dividends, [], NOW, 'user-a');
    expect(d1[0].id).toBe(d2[0].id);
  });

  it('are not credited twice: an entry with the same dividend, under any id, counts', () => {
    const first = computeDividendCredits([holding], dividends, [], NOW, 'user-a')[0];
    const local = { id: first.id, type: 'dividend', amount: first.amount, currency: 'USD', relatedId: first.relatedId, createdAt: 'x' } as any;
    expect(computeDividendCredits([holding], dividends, [local], NOW, 'user-a')).toEqual([]);
    // As pulled from the server: relatedId arrives as the hashed uuid.
    const pulled = { ...local, id: 'some-other-id', relatedId: legacyIdToUuid(first.relatedId) };
    expect(computeDividendCredits([holding], dividends, [pulled], NOW, 'user-a')).toEqual([]);
    // An entry from before this change (old id scheme) also counts.
    const legacy = { ...local, id: legacyIdToUuid('div:AAPL:2026-10-05') };
    expect(computeDividendCredits([holding], dividends, [legacy], NOW, 'user-a')).toEqual([]);
  });
});
