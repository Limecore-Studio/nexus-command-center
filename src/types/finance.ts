export type TransactionType = 'expense' | 'income' | 'transfer';
export type SyncStatus = 'pending' | 'synced';

export interface Transaction {
  id: string;
  amount: number;
  description: string;
  categoryId?: string;
  date: string;
  type: TransactionType;
  notes?: string;
  syncStatus: SyncStatus;
  createdAt: string;
  /**
   * v1.2 follow-up — CTO Account refactor. Source account for income +
   * expense, and the SOURCE leg of a transfer. Required for new
   * transactions; optional on the type because the Dexie v12 upgrade hook
   * back-fills via best-guess (category's defaultAccountId → first cash
   * account → first checking → first account by createdAt) and falls back
   * to undefined when no account exists yet (very new user / first launch).
   * Selectors that compute account balances treat undefined as "skip".
   */
  accountId?: string;
  /**
   * v1.2 follow-up — CTO Account refactor. Destination account for
   * `type === 'transfer'`. Must differ from `accountId` (enforced in the
   * AddTransaction UI). Undefined for expense / income transactions.
   */
  destinationAccountId?: string;
  /** v1.19 (NCC#202): the recurring rule that generated this row. */
  recurringRuleId?: string;
}

export interface BudgetCategory {
  id: string;
  name: string;
  monthlyLimit: number;
  icon?: string;
  createdAt: string;
  // Populated by cloud pull. When set and != current user's id, this row is
  // shared *to* us by another user — the Sharing UI uses this to render a
  // "Shared by …" tag and gate destructive actions.
  ownerId?: string;
  /**
   * v1.2 follow-up — CTO Account refactor. PRE-SELECTED account for new
   * transactions in this category. Replaces the old `linkedManualAssetId`
   * "auto-debit bridge" semantics (BUG-6 patch) — that hack is no longer
   * needed because in the Account model every transaction now carries its
   * own `accountId` and the account's balance is DERIVED from the
   * transaction set itself (see `lib/accountBalance.ts`). No double-
   * bookkeeping. UI use only: AddTransaction defaults its Account picker to
   * this value when the user selects a category that has one.
   *
   * Field name `linkedManualAssetId` kept rather than renamed `defaultAccountId`
   * to avoid the Dexie row migration overhead — the on-disk shape is
   * unchanged; semantics shift in the calling code. A future cleanup pass
   * renames the field once the legacy bridge helpers are fully removed.
   */
  linkedManualAssetId?: string;
}

export type AssetType = 'stock' | 'crypto' | 'etf';

export interface PortfolioHolding {
  id: string;
  ticker: string;
  name: string;
  assetType: AssetType;
  // Quantity and avgCostNative are CACHED aggregates derived from lots
  // (sum of qty; weighted avg of cost). When a holding has zero lots the
  // user-entered quantity remains in place as a fallback and P/L is hidden.
  quantity: number;
  createdAt: string;
  currentPrice?: number;
  priceChange?: number;
  cacheAge?: number;
  // Cost basis — weighted average purchase price per unit and the currency
  // the user paid in. Re-computed from lots whenever they change; nullable
  // before any lot exists. Currency may differ from quote currency (bought
  // GOOG in EUR through a euro broker → quote USD, cost EUR); FX conversion
  // happens at render time.
  avgCostNative?: number;
  costCurrency?: string;
  // Manual sector — overrides what we'd auto-derive from Finnhub's
  // /stock/profile2 (which is blank for ETFs and most international tickers).
  // When set, the allocation donut's Sector view uses this verbatim.
  sectorOverride?: string;
}

// One purchase. Multiple lots → same holding stack so the user can record
// real buying patterns instead of having to maintain a synthetic avg cost.
// Sales aren't modeled yet (deferred); when added they'd live in this table
// as `quantity < 0` lots or in a sibling sales table.
export interface PortfolioLot {
  id: string;
  holdingId: string;
  quantity: number;
  costPerUnit: number;
  costCurrency: string;
  // ISO date (YYYY-MM-DD) — date only, time-of-day not meaningful for purchase
  // record-keeping. Optional so legacy synthesized lots from pre-lots data
  // can be stamped without inventing a date the user didn't provide.
  purchaseDate?: string;
  notes?: string;
  /**
   * v1.3.1 (BUG-23) — shares from this lot consumed by FIFO stock sales.
   * A lot's remaining (still-held) shares = `quantity - (soldShares ?? 0)`.
   * Position size everywhere nets this out. Defaults to 0; the Dexie v15
   * upgrade hook back-fills existing rows.
   */
  soldShares?: number;
  /** v1.19 (NCC#202): the recurring rule that generated this row. */
  recurringRuleId?: string;
  syncStatus: SyncStatus;
  createdAt: string;
  updatedAt?: string;
}

// v1.3.1 (BUG-23) — FIFO audit-trail entry: which lot supplied how many of
// the shares sold, captured at sale time.
export interface LotAllocation {
  lotId: string;
  sharesTaken: number;
}

// v1.3.1 (BUG-23) — a realized stock sale. Cost basis is computed at sale
// time via FIFO across the holding's lots (oldest first); `lotAllocations`
// is the audit trail of which lots supplied the sold shares. Sales are
// append-only records — the active position is derived from lots (each lot's
// `soldShares` grows), and realized P&L is the Σ of `realizedGainLoss`.
export interface StockSale {
  id: string;
  ticker: string;
  holdingId?: string;
  sharesSold: number;
  salePricePerShare: number;
  costBasisPerShare: number;   // FIFO weighted-average at sale time
  realizedGainLoss: number;    // (salePrice − costBasis) × sharesSold, in `currency`
  currency: string;
  soldAt: string;              // ISO date (YYYY-MM-DD)
  lotAllocations: LotAllocation[];
  syncStatus: SyncStatus;
  createdAt: string;
}

// ─── v1.3.2 — Portfolio cash ledger ────────────────────────────────────────
//
// An append-only ledger of cash movements inside the portfolio. The portfolio
// cash balance = Σ(amount converted to base) — `amount` is SIGNED (positive
// adds cash, negative removes it). Append-only keeps multi-device sync a clean
// union (no lost-update races on a mutable scalar) and lets the balance
// re-derive when the base currency changes.
//
// Movements:
//   - `sell`       +proceeds  (auto on a stock sale)
//   - `buy`        −cost      (auto on a new lot; portfolio cash can go
//                              negative → the UI prompts to deposit to cover)
//   - `deposit`    +amount    (transfer in from a cash/savings account)
//   - `withdrawal` −amount    (transfer out to a cash/savings account)
//   - `adjust`     ±amount    (manual correction, reserved)
//   - `dividend`   +amount    (v1.7 — auto-realized on/after a holding's
//                              dividend pay date; credits portfolio cash so a
//                              projected dividend becomes real income instead
//                              of silently vanishing when the date passes)
//
// Start-at-zero / going-forward: lots & sales that pre-date this feature do
// NOT get entries (existing holdings are treated as already funded). Only new
// buys/sells/transfers move cash. Dividends are likewise realized only from
// the first run of v1.7 forward (anchored in lib/dividendRealize.ts) so an
// upgrade doesn't back-credit the whole trailing-12m dividend history at once.
export type PortfolioCashEntryType =
  | 'deposit'
  | 'withdrawal'
  | 'buy'
  | 'sell'
  | 'adjust'
  | 'dividend';

export interface PortfolioCashEntry {
  id: string;
  type: PortfolioCashEntryType;
  /** Signed amount in `currency`: + increases portfolio cash, − decreases it. */
  amount: number;
  currency: string;
  /** deposit/withdrawal: the counterpart account (ManualAsset) id. */
  accountId?: string;
  /** buy/sell: the originating lot / sale id, so deleting it removes this entry. */
  relatedId?: string;
  note?: string;
  /** v1.18.1 (NCC#176) — deposit/withdrawal: `amount` as it hit the account,
   *  in `accountCurrency`, at the rate used on the day (same sign as
   *  `amount`). The history views use it instead of re-converting at today's
   *  rate. LOCAL-ONLY: `portfolio_cash_entries` has no column for it, so it
   *  is not pushed; the pull keeps the local value (cloudSyncHydrate), and an
   *  entry made on another device, or before v1.18.1, falls back to today's
   *  rate. Unindexed, so no Dexie version bump. */
  accountAmount?: number;
  accountCurrency?: string;
  /** v1.19 (NCC#202): the recurring rule that generated this row. */
  recurringRuleId?: string;
  createdAt: string;
  syncStatus: SyncStatus;
}

// v1.2 follow-up — CTO Account-based finance refactor. Replaces the
// "manual balance entry" mental model with a first-class Account that
// derives its balance from the transactions hitting it.
//
//   derivedBalance(account, txns) =
//     startingBalance
//     + Σ(income.amount where accountId == account.id)
//     − Σ(expense.amount where accountId == account.id)
//     + Σ(transfer.amount where destinationAccountId == account.id)
//     − Σ(transfer.amount where accountId == account.id)
//
// Liabilities (credit_card, loan) carry NEGATIVE startingBalance by
// convention — a $2,000 credit-card balance owed reads as -2000. Net Worth
// is just the sum of derivedBalance across all accounts (plus portfolio).
// Credit card charges = expenses against the credit account (balance
// becomes more negative); paying the credit card = a Transfer from a
// checking account → the credit-card account (credit moves toward zero;
// checking drops by the payment amount). No special-casing required.
//
// **Schema transition strategy (dual-field).** The on-disk row keeps the
// legacy `assetType` + `value` fields alongside the new canonical
// `accountType` + `startingBalance`. Both stay in sync — every store write
// populates all four — so any straggling consumer reading the old field
// names keeps working without a code change. The Dexie v12 upgrade hook
// back-fills the new field names on existing rows. New code prefers
// `accountType` / `startingBalance`. Once every consumer has migrated, a
// future cleanup pass drops the legacy field names + the type alias.
export type AccountType =
  | 'checking'      // primary chequing-style transactional account
  | 'savings'       // interest-bearing reserve account
  | 'cash'          // physical / wallet cash
  | 'credit_card'   // revolving line — liability, negative balance by convention
  | 'investment'    // brokerage cash sleeve / managed account
  | 'property'      // real estate at marked book value
  | 'vehicle'       // car/boat at marked book value
  | 'loan'          // mortgage / personal loan — liability
  | 'other'         // catch-all
  | 'custom';       // user-named bucket

/** Account types that contribute NEGATIVELY to net worth. */
export const LIABILITY_ACCOUNT_TYPES: AccountType[] = ['credit_card', 'loan'];

/** Map any legacy ManualAsset `assetType` value to the canonical
 *  AccountType. Used by the Dexie v12 upgrade hook and by the store's
 *  add/update paths to keep the dual-field shape coherent. */
export function legacyAssetTypeToAccountType(
  legacy: string | undefined,
): AccountType {
  switch (legacy) {
    case 'credit':   return 'credit_card';
    case 'checking': // already canonical from a future row
    case 'savings':
    case 'cash':
    case 'credit_card':
    case 'investment':
    case 'property':
    case 'vehicle':
    case 'loan':
    case 'other':
    case 'custom':
      return legacy as AccountType;
    default:
      return 'other';
  }
}

export interface Account {
  id: string;
  name: string;
  /** Canonical account-type field — preferred by new code. */
  accountType: AccountType;
  /** Opening balance entered by the user at account creation. The DERIVED
   *  current balance is this value plus the signed sum of every Transaction
   *  that touches the account (income +, expense −, transfer in +, transfer
   *  out −). For liability accounts (credit card / loan) this is NEGATIVE
   *  by convention — a $2,000 credit-card balance owed reads as `-2000`. */
  startingBalance: number;
  currency: string;
  notes?: string;
  /** Soft-archive — hides from primary lists but preserves history. Set on
   *  delete by the store so transactions referencing the account still
   *  resolve to a row. */
  archivedAt?: string;
  syncStatus: SyncStatus;
  createdAt: string;
  updatedAt?: string;
  // ─── Legacy dual-field shape (kept in sync by the store) ──────────────
  // These are REQUIRED on the in-memory shape so existing callers keep
  // typechecking; the Dexie v12 upgrade hook back-fills them on existing
  // rows, and every store write populates them alongside the new fields.
  /** @deprecated mirror of `accountType` — kept on the row for back-compat
   *  with code that hasn't migrated yet. */
  assetType: AccountType;
  /** @deprecated mirror of `startingBalance` — kept on the row for
   *  back-compat with code that hasn't migrated yet. */
  value: number;
}

// ─── Legacy aliases (transitional) ────────────────────────────────────────
//
// Older code that still imports `ManualAsset` / `ManualAssetType` /
// `LIABILITY_TYPES` keeps building — the type aliases redirect to the new
// names and existing field reads (`asset.value`, `asset.assetType`) keep
// working because the dual-field on-disk shape preserves them.
/** @deprecated use AccountType */
export type ManualAssetType = AccountType;
/** @deprecated use LIABILITY_ACCOUNT_TYPES */
export const LIABILITY_TYPES: AccountType[] = LIABILITY_ACCOUNT_TYPES;
/** @deprecated use Account */
export type ManualAsset = Account;

// Tickers tracked without owning. Reuses the same Finnhub+Yahoo quote
// pipeline as portfolio_holdings; the quote results live in stockQuotes
// like any other equity. We just exclude them from P/L and allocation math.
export interface WatchlistItem {
  id: string;
  ticker: string;
  name: string;
  assetType: 'stock' | 'crypto' | 'etf';
  notes?: string;
  targetAbove?: number;
  targetBelow?: number;
  syncStatus: SyncStatus;
  createdAt: string;
  updatedAt?: string;
}

// One sampled snapshot of total portfolio value (in base currency). Written
// at most once per local day after a successful refresh. Local-only — we don't
// sync these since they're derivable from holdings + quotes, and re-running
// refresh on the other device will recreate them.
export interface PortfolioSnapshot {
  date: string; // YYYY-MM-DD (local time)
  valueBase: number;
  baseCurrency: string;
  createdAt: string;
}

/**
 * v1.2 — named savings target. Money is allocated from the user's liquid
 * cash+savings ManualAssets, minus the emergency buffer they set in
 * Settings. The store guards against overdraft; the UI surfaces "available
 * cash" so the user knows how much room they have.
 *
 * `allocatedAmount` is a directly-mutable scalar — no separate allocations
 * table. The user adjusts it via +/- buttons on the goal row. We trade audit
 * detail for simplicity; a future v1.3 can add an `allocations[]` event log
 * keyed on goal_id if "show me when I allocated each chunk" becomes valuable.
 *
 * Currency is captured at creation (defaults to baseCurrency) and stays
 * with the goal. Cross-currency goals work — the available-cash computation
 * converts every cash/savings asset into the goal's currency via fxRates
 * before checking headroom.
 *
 * Auto-completion: when `allocatedAmount >= targetAmount`, the store stamps
 * `completedAt`. The goal stays in the list (completed goals fall to the
 * bottom and render in a muted style). Manual un-complete is possible by
 * reducing allocation below target — the auto-stamp re-clears if needed.
 */
export interface SavingsGoal {
  id: string;
  title: string;
  targetAmount: number;
  currency: string;             // defaults to baseCurrency at creation
  allocatedAmount: number;      // user-managed, never negative
  deadline?: string;            // YYYY-MM-DD, optional
  notes?: string;
  completedAt?: string;         // ISO timestamp when allocated first reached target
  deletedAt?: string;           // soft-delete tombstone for sync
  syncStatus: SyncStatus;
  createdAt: string;
  updatedAt: string;
  /**
   * v1.2 follow-up — BUG-5. Pinned singleton goal representing the user's
   * emergency cash buffer. Exactly one goal per user carries this flag
   * (enforced by `ensureBufferGoal()` in the store). Special UI treatment:
   *   - Always sorts to the top of the list
   *   - Non-deletable (delete button hidden / store refuses)
   *   - `targetAmount` is the user's chosen runway target (optional — 0 is fine)
   *   - `allocatedAmount` is what's actually reserved; both Net Worth's
   *     "Savings Buffer" card AND `computeAvailableCash` read from this
   *     value, so the previously-duplicated buffer concept now has one
   *     source of truth.
   * Migrated from `useSettingsStore.savingsBufferAmount` on first load.
   */
  isBuffer?: boolean;
}

export interface ApiCacheEntry {
  cacheKey: string;
  data: string;
  fetchedAt: string;
  expiresAt: string;
}
