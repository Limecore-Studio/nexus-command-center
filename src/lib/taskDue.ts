// v1.18.1 (NCC#193) — a task's due value comes in two forms.
//
//   • An ISO instant ("2026-10-19T12:30:00.000Z"): what Add Task and Quick Log
//     store, and what the server keeps in `tasks.due_at`.
//   • A bare date ("2026-10-19"): what `tasks.due_date` holds. Rows written
//     before due_at existed, or by a pre-1.18.1 client, carry only this.
//
// `new Date("2026-10-19")` is UTC midnight, which is 03:00 in Helsinki — the
// "due at 3 am" that a sync used to leave behind. A bare date is a local
// calendar day, so it is read here as that day at DATE_ONLY_HOUR local time.

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** The hour a date-only due value is shown and reminded at. */
export const DATE_ONLY_HOUR = 9;

export function isDateOnly(due: string): boolean {
  return DATE_ONLY.test(due);
}

/** The due moment as a Date. Date-only → DATE_ONLY_HOUR local on that day.
 *  Null when the value doesn't parse. */
export function dueInstant(due: string): Date | null {
  if (isDateOnly(due)) {
    const [y, m, d] = due.split('-').map(Number);
    return new Date(y, m - 1, d, DATE_ONLY_HOUR, 0, 0, 0);
  }
  const t = new Date(due);
  return Number.isNaN(t.getTime()) ? null : t;
}

/** The local calendar day of a due value, as YYYY-MM-DD. This is what goes in
 *  `tasks.due_date`: before 1.18.1 the push sent the instant and Postgres kept
 *  its UTC day, so a task due 00:00–02:59 in Helsinki landed on the day before. */
export function dueLocalDate(due: string): string | null {
  if (isDateOnly(due)) return due;
  const t = dueInstant(due);
  if (!t) return null;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
}

/** The full instant for `tasks.due_at`, or null for a date-only value. */
export function dueAtForServer(due: string): string | null {
  if (isDateOnly(due)) return null;
  const t = dueInstant(due);
  return t ? t.toISOString() : null;
}

/** The local due value from a pulled row: due_at when the server has it,
 *  otherwise the bare due_date. */
export function dueFromServer(row: { due_at?: string | null; due_date?: string | null }): string | undefined {
  if (row.due_at) {
    const t = new Date(row.due_at);
    if (!Number.isNaN(t.getTime())) return t.toISOString();
  }
  return row.due_date ?? undefined;
}
