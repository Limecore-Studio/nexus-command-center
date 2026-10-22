// User preferences. Currently base currency for the portfolio + the Sunday
// Weekly Review reminder toggle + per-category notification toggles.
// Persisted via Capacitor Preferences (with localStorage fallback for web dev).
import { create, type StoreApi } from 'zustand';
import { Preferences } from '@capacitor/preferences';

// Re-exported so existing importers keep working; the list itself lives in
// lib/currencies.ts, which is now the only place it is defined.
import { SUPPORTED_CURRENCIES, isSupportedCurrency, type BaseCurrency } from '../lib/currencies';
export { SUPPORTED_CURRENCIES, isSupportedCurrency };
export type { BaseCurrency };

const CURRENCY_KEY = 'settings.baseCurrency';
const REMINDER_KEY = 'settings.weeklyReminder';
// Master kill-switch for ALL notifications. When OFF, no category fires
// regardless of its individual toggle — the lib/*Alerts modules check this
// flag first. When ON, the per-category toggles below take over.
const NOTIF_MASTER_KEY = 'settings.notif.master';
// Per-category notification toggles. Each one independently controls whether
// its feature schedules notifications when the relevant event happens. The
// master toggle above gates all of them in one switch; the OS permission
// gates the whole stack from below.
const NOTIF_TASKS_KEY = 'settings.notif.tasks';
const NOTIF_BUDGETS_KEY = 'settings.notif.budgets';
const NOTIF_PORTFOLIO_EOD_KEY = 'settings.notif.portfolioEod';
const NOTIF_NEWS_KEY = 'settings.notif.news';
// v1.15 Item 9 — Watchlist price-target alerts.
const NOTIF_WATCHLIST_KEY = 'settings.notif.watchlist';
// Macro-headline opt-in (Fed / CPI / jobs / inflation / FOMC). Off by default
// because the keyword classifier is noisier than the index-move trigger;
// users who actually want macro-event alerts flip this on explicitly.
const NOTIF_MACRO_KEYS_KEY = 'settings.notif.macroKeywords';
// Tracks whether we've shown the first-launch explainer modal. Set to '1'
// the first time the user dismisses the modal (whether they accept or
// decline notifications). Without this gate the modal would re-fire on
// every cold launch.
const NOTIF_INTRO_SEEN_KEY = 'settings.notif.introSeen';
// v1.2 — Savings buffer. Amount of cash+savings to reserve as emergency
// runway; excluded from "available to allocate" math in the Savings Goals
// module. Stored as a stringified number in baseCurrency. Defaults to 0 so
// existing users see the new feature with all their cash labeled as
// allocatable until they explicitly set a reserve.
const SAVINGS_BUFFER_KEY = 'settings.savings.bufferAmount';
// v1.2 — Insights two-tab toggle. Persisted choice between Technical and
// Fundamental tabs so the user's view + row pills follow them across
// cold starts. Defaults to 'technical' (the v1.0 behaviour) so existing
// users see the same rating they were already looking at.
const INSIGHTS_TAB_KEY = 'settings.insights.tab';
export type InsightsTab = 'technical' | 'fundamental';
// v1.8 — master switch for the cloud AI features. Off by default, and that
// default is deliberate: the Life-tab narrative used to generate itself the
// moment the tab had a ready report, with no user action anywhere in the path.
// The privacy policy told users the AI was opt-in and only ran on a button
// press, which was true of StudyDesk's and LimeLog's debriefs but not of this.
// Rather than reword the promise, this makes it true — nothing reaches Gemini
// until the user turns this on.
const AI_ENABLED_KEY = 'settings.ai.enabled';
// v1.9 — UI scale. Stored as the string the user picked, or absent for
// 'auto' (the per-tier default). See index.css's --ui-scale block.
const UI_SCALE_KEY = 'settings.ui.scale';

/**
 * v1.9 — UI scale steps. `auto` defers to the per-tier default set in CSS
 * (1.0 on phone/tablet, 1.2 on desktop); every other value is an explicit
 * choice applied at every tier, including a deliberate 1.0 on desktop.
 *
 * Same 'auto until you touch it' semantics as the sidebar rail preference, so
 * the two settings behave alike rather than each inventing a rule.
 */
export const UI_SCALES = ['auto', '1', '1.1', '1.2', '1.35', '1.5'] as const;
export type UiScale = (typeof UI_SCALES)[number];

/**
 * Applies the choice by setting `--ui-scale` INLINE on <html>, which outranks
 * the stylesheet's tier default in both directions. `auto` removes the inline
 * property so the media query takes over again.
 *
 * Lives here rather than in a component so the value is applied by whoever
 * loads settings first — including before the lock screen paints, which is
 * itself a screen the user reads.
 */
export function applyUiScale(scale: UiScale): void {
  const root = document.documentElement;
  if (scale === 'auto') root.style.removeProperty('--ui-scale');
  else root.style.setProperty('--ui-scale', scale);
}

interface SettingsStore {
  baseCurrency: BaseCurrency;
  weeklyReminder: boolean;
  notifMasterEnabled: boolean;
  notifTasksEnabled: boolean;
  notifBudgetsEnabled: boolean;
  notifPortfolioEodEnabled: boolean;
  notifNewsEnabled: boolean;
  notifWatchlistEnabled: boolean;
  notifMacroKeywordsEnabled: boolean;
  notifIntroSeen: boolean;
  /** v1.2 — emergency buffer reserved from cash+savings ManualAssets, in
   *  baseCurrency. Excluded from Savings Goals' available-to-allocate
   *  computation. */
  savingsBufferAmount: number;
  /** v1.2 — which Insights tab the user has active. Drives both the
   *  Insights screen content and which composite the RatingPill on
   *  portfolio + watchlist rows displays. */
  insightsTab: InsightsTab;
  /** v1.8 — whether the cloud AI features may run. Gates the Life-tab
   *  narrative; when false nothing is sent to the `ai-generate` function. */
  /** 'auto' follows the tier default (1.0 phone/tablet, 1.2 desktop); any
   *  other value is an explicit user choice applied at every tier. */
  uiScale: UiScale;
  aiEnabled: boolean;
  loaded: boolean;
  load: () => Promise<void>;
  setBaseCurrency: (c: BaseCurrency) => Promise<void>;
  setWeeklyReminder: (on: boolean) => Promise<void>;
  setNotifMasterEnabled: (on: boolean) => Promise<void>;
  setNotifTasksEnabled: (on: boolean) => Promise<void>;
  setNotifBudgetsEnabled: (on: boolean) => Promise<void>;
  setNotifPortfolioEodEnabled: (on: boolean) => Promise<void>;
  setNotifNewsEnabled: (on: boolean) => Promise<void>;
  setNotifWatchlistEnabled: (on: boolean) => Promise<void>;
  setNotifMacroKeywordsEnabled: (on: boolean) => Promise<void>;
  setNotifIntroSeen: (seen: boolean) => Promise<void>;
  setSavingsBufferAmount: (amount: number) => Promise<void>;
  setInsightsTab: (tab: InsightsTab) => Promise<void>;
  setAiEnabled: (on: boolean) => Promise<void>;
  setUiScale: (s: UiScale) => Promise<void>;
}

async function readPref(key: string): Promise<string | null> {
  try {
    const { value } = await Preferences.get({ key });
    if (value) return value;
  } catch {
    return localStorage.getItem(key);
  }
  return null;
}

async function writePref(key: string, value: string): Promise<void> {
  try {
    await Preferences.set({ key, value });
  } catch {
    localStorage.setItem(key, value);
  }
}

// Tiny helper — every notification toggle is a "1"/"0" string in Preferences,
// so this collapses the repetitive read+coerce dance.
async function readBoolPref(key: string, fallback = false): Promise<boolean> {
  const raw = await readPref(key);
  if (raw === null) return fallback;
  return raw === '1';
}

let loadInFlight: Promise<void> | null = null;

async function readSettings(set: StoreApi<SettingsStore>['setState']): Promise<void> {
  const [
    currency,
    reminder,
    notifMaster,
    notifTasks,
    notifBudgets,
    notifPortfolioEod,
    notifNews,
    notifWatchlist,
    notifMacroKeywords,
    notifIntroSeen,
    savingsBuffer,
    insightsTab,
    aiEnabled,
    uiScale,
  ] = await Promise.all([
    readPref(CURRENCY_KEY),
    readPref(REMINDER_KEY),
    readBoolPref(NOTIF_MASTER_KEY),
    readBoolPref(NOTIF_TASKS_KEY),
    readBoolPref(NOTIF_BUDGETS_KEY),
    readBoolPref(NOTIF_PORTFOLIO_EOD_KEY),
    readBoolPref(NOTIF_NEWS_KEY),
    readBoolPref(NOTIF_WATCHLIST_KEY),
    readBoolPref(NOTIF_MACRO_KEYS_KEY),
    readBoolPref(NOTIF_INTRO_SEEN_KEY),
    readPref(SAVINGS_BUFFER_KEY),
    readPref(INSIGHTS_TAB_KEY),
    readBoolPref(AI_ENABLED_KEY),
    readPref(UI_SCALE_KEY),
  ]);
  set({
    baseCurrency:
      currency && (SUPPORTED_CURRENCIES as readonly string[]).includes(currency)
        ? (currency as BaseCurrency)
        : 'EUR',
    weeklyReminder: reminder === '1',
    notifMasterEnabled: notifMaster,
    notifTasksEnabled: notifTasks,
    notifBudgetsEnabled: notifBudgets,
    notifPortfolioEodEnabled: notifPortfolioEod,
    notifNewsEnabled: notifNews,
    notifWatchlistEnabled: notifWatchlist,
    notifMacroKeywordsEnabled: notifMacroKeywords,
    notifIntroSeen,
    savingsBufferAmount: savingsBuffer ? Math.max(0, parseFloat(savingsBuffer) || 0) : 0,
    insightsTab: insightsTab === 'fundamental' ? 'fundamental' : 'technical',
    // An unrecognised stored value (hand-edited, or written by a future
    // version) falls back to auto rather than being applied verbatim to a
    // CSS property that would silently break every size in the app.
    uiScale: (UI_SCALES as readonly string[]).includes(uiScale ?? '')
      ? (uiScale as UiScale)
      : 'auto',
    aiEnabled,
    loaded: true,
  });
  applyUiScale(
    (UI_SCALES as readonly string[]).includes(uiScale ?? '') ? (uiScale as UiScale) : 'auto',
  );
}

export const useSettingsStore = create<SettingsStore>((set) => ({
  baseCurrency: 'EUR',
  weeklyReminder: false,
  // Master toggle defaults to FALSE so a fresh install never schedules a
  // notification before the user has opted in. The first-launch explainer
  // modal flips this on when the user taps "Enable Notifications"; the
  // Settings master toggle does the same on demand.
  notifMasterEnabled: false,
  notifTasksEnabled: false,
  notifBudgetsEnabled: false,
  notifPortfolioEodEnabled: false,
  notifNewsEnabled: false,
  notifWatchlistEnabled: false,
  notifMacroKeywordsEnabled: false,
  notifIntroSeen: false,
  savingsBufferAmount: 0,
  insightsTab: 'technical',
  uiScale: 'auto',
  aiEnabled: false,
  loaded: false,

  // v1.18.1 (NCC#151): callers that ask while a read is in flight share it.
  // AppShell and NotificationBridge both load on mount, and scheduleNotification
  // now loads too when settings are not loaded yet, once per alarm, so a cold
  // start with a few habits would otherwise start a dozen identical reads.
  load() {
    loadInFlight ??= readSettings(set).finally(() => {
      loadInFlight = null;
    });
    return loadInFlight;
  },

  async setBaseCurrency(c) {
    await writePref(CURRENCY_KEY, c);
    set({ baseCurrency: c });
  },

  async setWeeklyReminder(on) {
    await writePref(REMINDER_KEY, on ? '1' : '0');
    set({ weeklyReminder: on });
  },

  async setNotifMasterEnabled(on) {
    await writePref(NOTIF_MASTER_KEY, on ? '1' : '0');
    set({ notifMasterEnabled: on });
  },

  async setNotifTasksEnabled(on) {
    await writePref(NOTIF_TASKS_KEY, on ? '1' : '0');
    set({ notifTasksEnabled: on });
  },

  async setNotifBudgetsEnabled(on) {
    await writePref(NOTIF_BUDGETS_KEY, on ? '1' : '0');
    set({ notifBudgetsEnabled: on });
  },

  async setNotifPortfolioEodEnabled(on) {
    await writePref(NOTIF_PORTFOLIO_EOD_KEY, on ? '1' : '0');
    set({ notifPortfolioEodEnabled: on });
  },

  async setNotifNewsEnabled(on) {
    await writePref(NOTIF_NEWS_KEY, on ? '1' : '0');
    set({ notifNewsEnabled: on });
  },

  async setNotifWatchlistEnabled(on) {
    await writePref(NOTIF_WATCHLIST_KEY, on ? '1' : '0');
    set({ notifWatchlistEnabled: on });
  },

  async setNotifMacroKeywordsEnabled(on) {
    await writePref(NOTIF_MACRO_KEYS_KEY, on ? '1' : '0');
    set({ notifMacroKeywordsEnabled: on });
  },

  async setNotifIntroSeen(seen) {
    await writePref(NOTIF_INTRO_SEEN_KEY, seen ? '1' : '0');
    set({ notifIntroSeen: seen });
  },

  async setSavingsBufferAmount(amount) {
    const clamped = Math.max(0, isFinite(amount) ? amount : 0);
    await writePref(SAVINGS_BUFFER_KEY, String(clamped));
    set({ savingsBufferAmount: clamped });
  },

  async setInsightsTab(tab) {
    await writePref(INSIGHTS_TAB_KEY, tab);
    set({ insightsTab: tab });
  },

  async setAiEnabled(on) {
    await writePref(AI_ENABLED_KEY, on ? '1' : '0');
    set({ aiEnabled: on });
  },

  async setUiScale(next) {
    await writePref(UI_SCALE_KEY, next);
    set({ uiScale: next });
    applyUiScale(next);
  },
}));
