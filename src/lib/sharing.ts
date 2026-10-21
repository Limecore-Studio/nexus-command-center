// Sharing API — thin wrappers around the Supabase RPCs that handle invite-by-email,
// plus direct table reads for "who is this currently shared with?" and revoke.
//
// All RPCs are SECURITY DEFINER on the server (see migration
// `sharing_email_and_invite_rpcs`) — they verify ownership, resolve email →
// user_id, and atomically insert into the *_shares table. The existing
// rate-limit trigger (50/day) fires on insert.
//
// Reads of the share tables themselves are RLS-protected: both the granter
// and the recipient can SELECT their share rows. Deletes require ownership
// (the granter can revoke).

import { supabase } from './supabase';

// v1.18.1 (NCC#157): sharing is switched off on the server. share_task,
// share_budget_category and get_public_profiles are not executable by
// signed-in users, so every invite failed with
// "permission denied" behind a share button that still showed. The buttons
// stay hidden until the server side is re-enabled; turn this back on in the
// same change that does that.
export const SHARING_ENABLED = false;

export type SharePermission = 'read' | 'write';

export interface ShareRow {
  user_id: string;
  granted_by: string;
  permission: SharePermission;
  created_at: string;
  // Display fields, hydrated client-side via get_public_profiles.
  display_name?: string | null;
  avatar_url?: string | null;
}

// =============================================================================
// Public profile hydration
// =============================================================================
async function getPublicProfiles(
  userIds: string[]
): Promise<Record<string, { full_name: string | null; avatar_url: string | null }>> {
  if (userIds.length === 0) return {};
  const { data, error } = await supabase.rpc('get_public_profiles', {
    profile_ids: userIds,
  });
  if (error) throw error;
  const out: Record<string, { full_name: string | null; avatar_url: string | null }> = {};
  for (const row of data ?? []) {
    out[row.id] = { full_name: row.full_name, avatar_url: row.avatar_url };
  }
  return out;
}

// =============================================================================
// Budget category sharing
// =============================================================================
export async function listBudgetCategoryShares(categoryId: string): Promise<ShareRow[]> {
  const { data, error } = await supabase
    .from('budget_category_shares')
    .select('user_id, granted_by, permission, created_at')
    .eq('category_id', categoryId);
  if (error) throw error;
  return hydrateNames((data ?? []) as ShareRow[]);
}

export async function shareBudgetCategoryByEmail(
  categoryId: string,
  email: string,
  permission: SharePermission
): Promise<void> {
  const { error } = await supabase.rpc('share_budget_category', {
    p_category_id: categoryId,
    p_email: email,
    p_permission: permission,
  });
  if (error) throw error;
}

export async function revokeBudgetCategoryShare(
  categoryId: string,
  userId: string
): Promise<void> {
  const { error } = await supabase
    .from('budget_category_shares')
    .delete()
    .eq('category_id', categoryId)
    .eq('user_id', userId);
  if (error) throw error;
}

// =============================================================================
// Task sharing
// =============================================================================
export async function listTaskShares(taskId: string): Promise<ShareRow[]> {
  const { data, error } = await supabase
    .from('task_shares')
    .select('user_id, granted_by, permission, created_at')
    .eq('task_id', taskId);
  if (error) throw error;
  return hydrateNames((data ?? []) as ShareRow[]);
}

export async function shareTaskByEmail(
  taskId: string,
  email: string,
  permission: SharePermission
): Promise<void> {
  const { error } = await supabase.rpc('share_task', {
    p_task_id: taskId,
    p_email: email,
    p_permission: permission,
  });
  if (error) throw error;
}

export async function revokeTaskShare(taskId: string, userId: string): Promise<void> {
  const { error } = await supabase
    .from('task_shares')
    .delete()
    .eq('task_id', taskId)
    .eq('user_id', userId);
  if (error) throw error;
}

// =============================================================================
// Internal
// =============================================================================
async function hydrateNames(rows: ShareRow[]): Promise<ShareRow[]> {
  if (rows.length === 0) return rows;
  const ids = Array.from(new Set(rows.map((r) => r.user_id)));
  const profiles = await getPublicProfiles(ids);
  return rows.map((r) => ({
    ...r,
    display_name: profiles[r.user_id]?.full_name ?? null,
    avatar_url: profiles[r.user_id]?.avatar_url ?? null,
  }));
}

// Human-friendly error message extraction. Supabase RPC errors come through
// with the Postgres message — we want to surface that as-is to the user since
// our RPCs raise explicit, user-facing messages like "No user found with that
// email" and "You cannot share with yourself".
export function describeShareError(e: unknown): string {
  if (e && typeof e === 'object' && 'message' in e) {
    const msg = String((e as { message: unknown }).message);
    if (msg.toLowerCase().includes('rate limit')) {
      return 'Invite rate limit reached (50/day). Try again tomorrow.';
    }
    return msg;
  }
  return 'Unknown error.';
}
