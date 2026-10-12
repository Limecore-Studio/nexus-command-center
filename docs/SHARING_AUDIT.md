# Sharing audit — `task_shares` / `budget_category_shares`

**Date:** 2026-09-14 · **Asked by:** v1.14 plan, "Revive task sharing and
budget-category sharing", step 1 — *audit first, before writing new code.*

> **Out of date (2026-10-12, v1.18.1, NCC#157).** Sharing does not work
> today. After this audit, `share_task`, `share_budget_category` and
> `get_public_profiles` were made non-executable for signed-in users, so
> every invite fails with 42501 (permission denied). The share buttons are
> hidden (`SHARING_ENABLED` in `src/lib/sharing.ts`), and migration
> `20261012_sharing_rpcs_execute_revoked.sql` records the revoke. Turning
> sharing back on is tracked in Limekana/limecore#62. The rest of this
> document describes the state on 2026-09-14.

## The question

> Find the invite/accept UI in the current NCC codebase and confirm whether
> it's (a) missing entirely, (b) built but unreachable from any nav path, or
> (c) reachable but broken. This determines whether the ticket is "build a
> feature," "add an entry point," or "fix a bug" — very different sizes.

## The answer is none of the three

The feature is **built, reachable, and working.** Nothing is missing and
nothing is broken. It has simply never been used.

That makes the ticket a fourth thing the options did not allow for, and a
much cheaper one than any of them: a discoverability and adoption problem,
which is exactly what the plan's own step 2 anticipated.

### What was checked

| Layer | State |
|---|---|
| API wrappers | `src/lib/sharing.ts` — list / invite-by-email / revoke, for both subjects |
| Modal | `src/components/ShareModal.tsx`, used by both screens |
| Task entry point | `TasksOverview.tsx:80` → row prop → `RowActions` share button. **Reachable** |
| Budget entry point | `ManageBudgets.tsx:236` → `RowActions` share button. **Reachable** |
| `share_task` RPC | Exists, `SECURITY DEFINER`, signature matches the client call |
| `share_budget_category` RPC | Exists, `SECURITY DEFINER`, signature matches |
| `get_public_profiles` RPC | Exists, `SECURITY DEFINER`, signature matches |
| Email resolution | `share_task` resolves via `profiles.email`; **745 of 746 profiles have one**, so this does not fail |
| Realtime | `realtime.ts` subscribes to both share tables, so a share appears live |

Production row counts, 2026-09-14: `task_shares` 0, `budget_category_shares`
0, `share_invite_rate_limits` 0, against 101 tasks across 21 owners and 29
budget categories.

### What the zero rate-limit rows do and do not tell us

`share_invite_rate_limits` is written by a trigger on **insert into the share
tables**, not by the RPC on attempt. So zero rows there is just a restatement
of zero shares: it cannot distinguish "nobody pressed the button" from
"somebody pressed it and the RPC raised before inserting".

Everything the RPC can raise on was checked directly instead — ownership,
permission value, email resolution, self-share — and none of them is in a
state that would fail for a normal user. Combined with a reachable button and
working RPCs, the likeliest reading by some distance is that the invite has
never been attempted.

## Two real defects found on the way

Both are small, both are now fixed, and neither is the reason for zero rows
on its own.

1. **The share affordance is an unlabelled glyph.** `RowActions` renders
   sharing as a bare `⇆` in a row of three small icon buttons, next to edit
   and delete. Nothing on the screen says an item can be shared at all.
2. **Every accessible name in `RowActions` was hardcoded English.** Share,
   Edit and Delete all carried a literal `aria-label`, so a screen reader in
   any of the other nine locales announced three English words. Found while
   fixing the share one — the first draft of this audit said share was the
   only offender, which was wrong: it was all three.

## The thing to decide, which is not a code change

**A share lands silently.** There is no invite, no accept, and no
notification: the RPC inserts the row, realtime pushes it, and the item
appears in the recipient's list with a "shared with you" badge. If they are
not looking at that screen at that moment, they will not know.

So even a user who finds the button and sends a share has no way to tell the
other person they did — and the other person has no way to discover it except
by noticing a new row. Any serious attempt to move these numbers needs to
answer that first. It is a bigger question than the button.

The plan's step 2 makes the other half of the point, and it still stands:
with NCC's active-user count, the number of people who currently have someone
to invite is probably small whatever the invite UX looks like. Worth
measuring the ceiling before spending much more on the funnel.
