import { create } from 'zustand';
import { db } from '../db/database';
import { enqueue } from '../db/syncQueue';
import { generateId } from '../utils/uuid';
import { localDateKey } from '../utils/formatters';
import { convertSync } from '../api/fxRates';
import i18n from '../i18n';
import type { RecurringRule } from '../types/recurring';
import { materializeDue } from '../lib/recurringMaterialize';
import { holdingUnitPrice } from '../lib/positionValue';
import { useFinanceStore } from './useFinanceStore';
import { useSettingsStore } from './useSettingsStore';

/**
 * v1.19 — NCC#202: recurring rules. Rules are stored and synced like every
 * other NCC row (Dexie first, then the queue; deletes are tombstones on the
 * server). Their occurrences are written by lib/recurringMaterialize.ts.
 */

/** What the editor supplies; the store fills in id, stamps and progress. */
export type RecurringRuleInput = Omit<
  RecurringRule,
  'id' | 'syncStatus' | 'createdAt' | 'updatedAt' | 'lastMaterializedDate' | 'pausedAt' | 'waitingSince'
>;

interface RecurringStore {
  rules: RecurringRule[];
  load: () => Promise<void>;
  add: (input: RecurringRuleInput) => Promise<RecurringRule>;
  /** Changes apply to future occurrences only; generated rows stay as they are. */
  update: (id: string, patch: Partial<RecurringRuleInput>) => Promise<void>;
  pause: (id: string) => Promise<void>;
  /** Resuming does not back-fill the paused stretch. */
  resume: (id: string) => Promise<void>;
  /** Number of rows the rule has generated (for the delete prompt). */
  countGenerated: (id: string) => Promise<number>;
  remove: (id: string, opts: { deletePast: boolean }) => Promise<void>;
  /** Writes every due occurrence, then refreshes the finance store. One run
   *  at a time; a call during a run waits for it and runs once more. */
  materialize: () => Promise<number>;
}

const yesterday = () => {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return localDateKey(d);
};

async function save(rule: RecurringRule, op: 'insert' | 'update'): Promise<void> {
  await db.recurringRules.put(rule);
  await enqueue('recurring_rule', rule.id, op, rule);
}

let running: Promise<number> | null = null;
let again = false;

async function runMaterialize(): Promise<number> {
  // The base currency must be the user's, not the default: a sync can end
  // before AppShell has loaded settings. AppShell runs this once they are.
  const settings = useSettingsStore.getState();
  if (!settings.loaded) return 0;
  const fin = useFinanceStore.getState();
  const baseCurrency = settings.baseCurrency;
  const res = await materializeDue({
    today: localDateKey(new Date()),
    baseCurrency,
    unitPrice: (h) => holdingUnitPrice(h, fin.stockQuotes, fin.cryptoPrices),
    convert: (amount, from, to) => convertSync(amount, from, to, fin.fxRates),
    depositLabel: i18n.t('recurring.depositLabel'),
  });
  if (res.created > 0) {
    await useFinanceStore.getState().load();
    for (const h of res.touchedHoldings) await useFinanceStore.getState().refreshHoldingAggregates(h);
  }
  return res.created;
}

export const useRecurringStore = create<RecurringStore>((set, get) => ({
  rules: [],

  async load() {
    const all = await db.recurringRules.toArray();
    all.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
    set({ rules: all });
  },

  async add(input) {
    const now = new Date().toISOString();
    const rule = {
      ...input,
      id: generateId(),
      syncStatus: 'pending',
      createdAt: now,
      updatedAt: now,
    } as RecurringRule;
    await save(rule, 'insert');
    await get().load();
    void get().materialize();
    return rule;
  },

  async update(id, patch) {
    const existing = await db.recurringRules.get(id);
    if (!existing) return;
    const next = { ...existing, ...patch, id, syncStatus: 'pending', updatedAt: new Date().toISOString() } as RecurringRule;
    await save(next, 'update');
    await get().load();
    void get().materialize();
  },

  async pause(id) {
    const existing = await db.recurringRules.get(id);
    if (!existing || existing.pausedAt) return;
    await save({ ...existing, pausedAt: new Date().toISOString(), syncStatus: 'pending', updatedAt: new Date().toISOString() }, 'update');
    await get().load();
  },

  async resume(id) {
    const existing = await db.recurringRules.get(id);
    if (!existing || !existing.pausedAt) return;
    // Skip the paused stretch: progress moves to yesterday (never backwards),
    // so today's occurrence, if any, is the first one written.
    const y = yesterday();
    const last = existing.lastMaterializedDate && existing.lastMaterializedDate > y ? existing.lastMaterializedDate : y;
    await save(
      { ...existing, pausedAt: undefined, lastMaterializedDate: last, syncStatus: 'pending', updatedAt: new Date().toISOString() },
      'update',
    );
    await get().load();
    void get().materialize();
  },

  async countGenerated(id) {
    // What the user sees as entries: a transaction (a deposit's transfer
    // included) or a lot. Their cash legs go with them.
    const [tx, lots] = await Promise.all([
      db.transactions.filter((r) => r.recurringRuleId === id).count(),
      db.portfolioLots.filter((r) => r.recurringRuleId === id).count(),
    ]);
    return tx + lots;
  },

  async remove(id, { deletePast }) {
    const existing = await db.recurringRules.get(id);
    if (!existing) return;
    if (deletePast) {
      const fin = useFinanceStore.getState();
      const lots = await db.portfolioLots.filter((r) => r.recurringRuleId === id).toArray();
      // deleteLot also removes the lot's cash entry and re-derives the holding.
      for (const l of lots) await fin.deleteLot(l.id);
      const txs = await db.transactions.filter((r) => r.recurringRuleId === id).toArray();
      for (const t of txs) await fin.deleteTransaction(t.id);
      const cash = await db.portfolioCashEntries.filter((r) => r.recurringRuleId === id).toArray();
      for (const c of cash) {
        await db.portfolioCashEntries.delete(c.id);
        await enqueue('portfolio_cash_entry', c.id, 'delete', { id: c.id });
      }
      await useFinanceStore.getState().load();
    }
    await db.recurringRules.delete(id);
    await enqueue('recurring_rule', id, 'delete', { id });
    await get().load();
  },

  async materialize() {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      let total = 0;
      try {
        do {
          again = false;
          total += await runMaterialize();
        } while (again);
      } catch (e) {
        console.warn('[recurring] materialize failed:', (e as Error).message);
      } finally {
        running = null;
      }
      await get().load();
      return total;
    })();
    return running;
  },
}));
