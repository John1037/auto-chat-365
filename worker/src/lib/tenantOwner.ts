import type { Env } from "./env";
import { getServiceClient } from "./supabase";

// Every document-management route needs this: derive the caller's own tenant_id
// from tenant_members by their verified auth.uid(), never from anything the client
// sends -- a client-supplied tenant_id would let one tenant's owner touch another's
// documents just by passing a different id in the request body.
export async function getOwnerTenantId(env: Env, userId: string): Promise<string | null> {
  const service = getServiceClient(env);
  const { data, error } = await service.from("tenant_members").select("tenant_id").eq("user_id", userId).maybeSingle();
  if (error || !data) return null;
  return data.tenant_id;
}

export interface OwnerMembership {
  tenantId: string;
  role: string;
}

// Same lookup as getOwnerTenantId, but also returns the caller's own role -- for
// routes that need to gate on it (e.g. only an owner/admin may delete the tenant
// account), not just resolve which tenant they belong to.
export async function getOwnerMembership(env: Env, userId: string): Promise<OwnerMembership | null> {
  const service = getServiceClient(env);
  const { data, error } = await service.from("tenant_members").select("tenant_id, role").eq("user_id", userId).maybeSingle();
  if (error || !data) return null;
  return { tenantId: data.tenant_id, role: data.role };
}
