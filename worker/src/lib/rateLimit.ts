import type { SupabaseClient } from "@supabase/supabase-js";

// Thin wrapper around the check_and_increment_rate_limit() Postgres function
// (supabase/migrations/0003_rate_limiting.sql). Must be called with the service
// client -- rate_limit_counters has no client-role RLS policies at all.
export async function checkRateLimit(
  serviceClient: SupabaseClient,
  tenantId: string,
  scope: "tenant" | "session",
  scopeKey: string,
  windowSeconds: number,
  limit: number,
): Promise<boolean> {
  const { data, error } = await serviceClient.rpc("check_and_increment_rate_limit", {
    p_tenant_id: tenantId,
    p_scope: scope,
    p_scope_key: scopeKey,
    p_window_seconds: windowSeconds,
    p_limit: limit,
  });
  if (error) throw new Error(`rate limit check failed: ${error.message}`);
  return data === true;
}
