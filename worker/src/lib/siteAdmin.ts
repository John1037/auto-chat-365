import type { Env } from "./env";
import { getServiceClient } from "./supabase";

// Checked live against the site_admins table on every call -- deliberately not
// derived from a JWT claim, so revoking access takes effect immediately rather than
// waiting for the caller's token to refresh. Uses the service client (not the
// caller's own RLS-scoped client) so this check works the same way regardless of
// what the site_admins RLS policy happens to allow that specific caller to see.
export async function isSiteAdmin(env: Env, userId: string): Promise<boolean> {
  const service = getServiceClient(env);
  const { data, error } = await service.from("site_admins").select("user_id").eq("user_id", userId).maybeSingle();
  return !error && data !== null;
}
