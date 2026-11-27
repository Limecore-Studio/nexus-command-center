// v1.22 (NCC#263) — what a goal's progress is computed from, in one place.
//
// Goals, the Dashboard and the Life screen each built their own DataSources.
// Life's left holdings, accounts and FX empty with a fixed EUR base, so every
// net-worth goal read 0% there and pulled the Work score down; Goals left out
// portfolio cash, so a bond or cash goal could differ from the Dashboard's.
// All three read this now, so the same goal shows the same percent anywhere.

import { useMemo } from 'react';
import { useFinanceStore } from '../store/useFinanceStore';
import { useTaskStore } from '../store/useTaskStore';
import { useStudiesStore } from '../store/useStudiesStore';
import { useFitnessStore } from '../store/useFitnessStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { liveGpa } from '../utils/gpa';
import type { DataSources } from './goals';

export function useGoalDataSources(): DataSources {
  const transactions = useFinanceStore((s) => s.transactions);
  const holdings = useFinanceStore((s) => s.holdings);
  const portfolioLots = useFinanceStore((s) => s.portfolioLots);
  const portfolioCashEntries = useFinanceStore((s) => s.portfolioCashEntries);
  const manualAssets = useFinanceStore((s) => s.manualAssets);
  const stockQuotes = useFinanceStore((s) => s.stockQuotes);
  const cryptoPrices = useFinanceStore((s) => s.cryptoPrices);
  const fxRates = useFinanceStore((s) => s.fxRates);
  const baseCurrency = useSettingsStore((s) => s.baseCurrency);
  const tasks = useTaskStore((s) => s.tasks);
  const studySessions = useStudiesStore((s) => s.studySessions);
  const currentImport = useStudiesStore((s) => s.currentImport);
  const gradeScale = useStudiesStore((s) => s.gradeScale);
  const workouts = useFitnessStore((s) => s.sessions);

  return useMemo(
    () => ({
      transactions,
      holdings,
      portfolioLots,
      portfolioCashEntries,
      manualAssets,
      stockQuotes,
      cryptoPrices,
      fxRates,
      baseCurrency,
      tasks,
      studySessions,
      workouts,
      currentGpa: liveGpa(currentImport), // v1.22 (NCC#262)
      gradeScale, // v1.19 (NCC#197)
    }),
    [transactions, holdings, portfolioLots, portfolioCashEntries, manualAssets, stockQuotes, cryptoPrices, fxRates, baseCurrency, tasks, studySessions, workouts, currentImport, gradeScale],
  );
}
