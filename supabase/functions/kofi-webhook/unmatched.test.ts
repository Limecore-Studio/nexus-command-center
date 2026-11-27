// Run: deno test supabase/functions/kofi-webhook/unmatched.test.ts
import { assertEquals } from 'jsr:@std/assert@1';
import { storeUnmatched } from './unmatched.ts';

type Call = { table: string; row: Record<string, unknown>; opts: unknown };

function client(error: { code?: string; message: string } | null) {
  const calls: Call[] = [];
  return {
    calls,
    from(table: string) {
      return {
        upsert(row: Record<string, unknown>, opts: { onConflict: string; ignoreDuplicates: boolean }) {
          calls.push({ table, row, opts });
          return Promise.resolve({ error });
        },
      };
    },
  };
}

const payment = { messageId: 'm-1', email: 'b@x.com', tier: 'Supporter' };

Deno.test('an unmatched payment is kept, keyed by message id; a replay is a no-op', async () => {
  const c = client(null);
  assertEquals(await storeUnmatched(c, payment), 'stored');
  assertEquals(c.calls, [{
    table: 'kofi_unmatched_payments',
    row: { message_id: 'm-1', email: 'b@x.com', tier: 'Supporter' },
    opts: { onConflict: 'message_id', ignoreDuplicates: true },
  }]);
});

Deno.test('before the migration (no table) it behaves as before: no-table', async () => {
  assertEquals(await storeUnmatched(client({ code: '42P01', message: 'relation does not exist' }), payment), 'no-table');
  assertEquals(await storeUnmatched(client({ code: 'PGRST205', message: 'not in schema cache' }), payment), 'no-table');
});

Deno.test('any other failure is failed, so Ko-fi retries', async () => {
  assertEquals(await storeUnmatched(client({ code: '57014', message: 'timeout' }), payment), 'failed');
  assertEquals(await storeUnmatched(client({ message: 'network' }), payment), 'failed');
});
