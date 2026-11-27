// v1.22 (limecore#112) — a membership payment no account matches is KEPT, not
// only logged. A supporter who checked out with a different address could
// never get that payment: the webhook answered 200 (so Ko-fi stops retrying)
// and the address and message id lived only in the short-lived function log.
//
// The row goes to public.kofi_unmatched_payments (service role only; created by
// the limecore migration). Verifying that address later, or confirming an
// account with it, calls public.kofi_claim_unmatched, which grants the
// entitlement from the newest unclaimed row of the last 34 days. Rows are
// purged after 35 days, claimed or not.

export interface UnmatchedPayment {
  messageId: string;
  /** Trimmed and lowercased, as the webhook matches it. */
  email: string;
  tier: string;
}

export type StoreOutcome =
  /** Kept (or already kept: a replayed delivery is a no-op). Answer 200. */
  | 'stored'
  /** The table does not exist yet (the migration is not applied). Behave as
   *  before it: log and answer 200, so deploy order cannot break deliveries. */
  | 'no-table'
  /** Any other failure. Answer 500 so Ko-fi retries and the payment is not
   *  lost. */
  | 'failed';

interface InsertClient {
  from(table: string): {
    upsert(
      row: Record<string, unknown>,
      opts: { onConflict: string; ignoreDuplicates: boolean },
    ): PromiseLike<{ error: { code?: string; message: string } | null }>;
  };
}

/** Postgres "undefined_table", or PostgREST's "table not in the schema cache". */
const MISSING_TABLE = new Set(['42P01', 'PGRST205']);

export async function storeUnmatched(client: InsertClient, p: UnmatchedPayment): Promise<StoreOutcome> {
  const { error } = await client
    .from('kofi_unmatched_payments')
    .upsert(
      { message_id: p.messageId, email: p.email, tier: p.tier },
      { onConflict: 'message_id', ignoreDuplicates: true },
    );
  if (!error) return 'stored';
  if (error.code && MISSING_TABLE.has(error.code)) return 'no-table';
  return 'failed';
}
