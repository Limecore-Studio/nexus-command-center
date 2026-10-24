// v1.19 — NCC#204: every bond holding has one 'coupon' recurring rule. Its
// occurrences are the coupon dates (each writes a `dividend` cash entry) and
// its last one, on the end date, is the maturity (the last coupon plus the
// redemption at face value). See recurringMaterialize.ts for what each date
// writes.
//
// The rule is derived, not entered: this keeps it in step with the holding's
// terms and lots before every materialisation. Its id is
// uuidv5(holdingId:coupon), so two devices derive the same rule, never two.
import { db } from '../db/database';
import { enqueue } from '../db/syncQueue';
import type { PortfolioHolding, PortfolioLot } from '../types/finance';
import type { RecurringRule } from '../types/recurring';
import { couponDateBefore } from './manualValuation';
import { parseDateLocal } from '@/utils/formatters';
import { uuidv5 } from './recurring';

export const couponRuleId = (holdingId: string) => uuidv5(`${holdingId}:coupon`);

/** The rule a bond holding should have, or null (no terms, or nothing held
 *  from a date the schedule can start at). */
export async function desiredCouponRule(h: PortfolioHolding, lots: PortfolioLot[]): Promise<RecurringRule | null> {
  const t = h.bond;
  if (h.assetType !== 'bond' || !t || !t.maturity) return null;
  const own = lots.filter((l) => l.holdingId === h.id);
  // Coupons are paid from the first date after the first purchase (or after
  // the holding was added, when it has no lots).
  const from = own.length
    ? own.map((l) => l.purchaseDate ?? l.createdAt.slice(0, 10)).sort()[0]
    : h.createdAt.slice(0, 10);
  const maturityDay = parseDateLocal(t.maturity).getDate();
  let startDate = t.maturity;
  if (t.couponFrequency) {
    // The first coupon date strictly after `from`, walking back from maturity.
    for (let k = 1; k < 2000; k++) {
      const d = couponDateBefore(t, k);
      if (d <= from) break;
      startDate = d;
    }
  }
  if (startDate <= from) return null; // matured before anything was held
  return {
    id: await couponRuleId(h.id),
    kind: 'coupon',
    template: { holdingId: h.id },
    // A zero-coupon bond has one occurrence: the maturity.
    every: t.couponFrequency ? 12 / t.couponFrequency : 12,
    unit: 'month',
    anchorDay: maturityDay,
    startDate,
    endDate: t.maturity,
    syncStatus: 'pending',
    createdAt: new Date().toISOString(),
  };
}

const SCHEDULE_KEYS = ['every', 'unit', 'anchorDay', 'startDate', 'endDate'] as const;

/** Creates, updates or (for a holding that is no longer a bond) removes the
 *  coupon rules, so the materialiser sees them current. A rule whose holding
 *  is not on this device yet is left alone: it waits for the holding. */
export async function reconcileCouponRules(): Promise<void> {
  const [holdings, lots, rules] = await Promise.all([
    db.portfolioHoldings.toArray(),
    db.portfolioLots.toArray(),
    db.recurringRules.filter((r) => r.kind === 'coupon').toArray(),
  ]);
  const byId = new Map(rules.map((r) => [r.id, r]));
  const wanted = new Set<string>();
  for (const h of holdings) {
    if (h.assetType !== 'bond') continue;
    const want = await desiredCouponRule(h, lots);
    if (!want) continue;
    wanted.add(want.id);
    const have = byId.get(want.id);
    if (!have) {
      await db.recurringRules.put(want);
      await enqueue('recurring_rule', want.id, 'insert', want);
      continue;
    }
    if (SCHEDULE_KEYS.every((k) => have[k] === want[k])) continue;
    // Terms or lots changed. Progress stays: dates already written are not
    // written again, and the new schedule continues after them.
    const next = { ...have, ...Object.fromEntries(SCHEDULE_KEYS.map((k) => [k, want[k]])), syncStatus: 'pending', updatedAt: new Date().toISOString() } as RecurringRule;
    await db.recurringRules.put(next);
    await enqueue('recurring_rule', next.id, 'update', next);
  }
  // A holding that is here but no longer a bond (or no longer has terms):
  // its rule goes. Rules for holdings not on this device are kept.
  const present = new Set(holdings.map((h) => h.id));
  for (const r of rules) {
    if (r.kind !== 'coupon' || wanted.has(r.id) || !present.has(r.template.holdingId)) continue;
    await removeCouponRule(r.id);
  }
}

/** Tombstones a coupon rule (deleting a bond holding). Entries it wrote stay. */
export async function removeCouponRule(ruleId: string): Promise<void> {
  if (!(await db.recurringRules.get(ruleId))) return;
  await db.recurringRules.delete(ruleId);
  await enqueue('recurring_rule', ruleId, 'delete', { id: ruleId });
}
