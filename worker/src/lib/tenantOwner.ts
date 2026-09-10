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
