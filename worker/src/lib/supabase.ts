import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "./env";

// Server-to-server client, authenticated as the Postgres `service_role` (BYPASSRLS)
// via the secret key. Used for anything that must write across tenants (minting
// anonymous visitor sessions, ingestion, provisioning) -- every query issued through
// this client MUST include an explicit tenant_id filter by hand, since RLS provides
// no protection here at all.
export function getServiceClient(env: Env): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// A client acting as a specific caller's own JWT, so PostgREST evaluates RLS as that
// user -- this is what makes the tenant-isolation policies in
// supabase/migrations/0004_rls_policies.sql actually apply. Use this whenever a
// request should only be able to see/touch what its own caller is allowed to.
export function getUserClient(env: Env, jwt: string): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export interface VerifiedUser {
  id: string;
  email: string | null;
  isAnonymous: boolean;
}

// Verifies a bearer token by round-tripping to GoTrue (auth.getUser), rather than
// decoding the JWT payload by hand -- this confirms the token hasn't been revoked,
// not just that it's well-formed. Returns null if the token is missing/invalid.
export async function getVerifiedUser(env: Env, jwt: string | null): Promise<VerifiedUser | null> {
  if (!jwt) return null;
  const client = getUserClient(env, jwt);
  const { data, error } = await client.auth.getUser(jwt);
  if (error || !data.user) return null;
  return { id: data.user.id, email: data.user.email ?? null, isAnonymous: data.user.is_anonymous === true };
}

export async function getVerifiedUserId(env: Env, jwt: string | null): Promise<string | null> {
  const user = await getVerifiedUser(env, jwt);
  return user?.id ?? null;
}

export function getBearerToken(request: Request): string | null {
  const header = request.headers.get("Authorization");
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length).trim() || null;
}
