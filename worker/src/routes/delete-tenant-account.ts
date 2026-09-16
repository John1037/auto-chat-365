import type { Env } from "../lib/env";
import { getServiceClient, getVerifiedUser, getBearerToken } from "../lib/supabase";
import { getOwnerMembership } from "../lib/tenantOwner";

const CONFIRMATION_PHRASE = "DELETE ACCOUNT";

interface DeleteAccountBody {
  confirmation?: string;
}

// Full, irreversible deletion of the caller's own tenant account -- see migration
// 0020's delete_tenant_account() for exactly what gets removed and why it all runs
// in one transaction. The typed confirmation phrase is checked here too, not only
// in the dashboard UI -- a client-side-only check is trivial to bypass with a direct
// API call, and this is about as high-consequence an action as this platform has.
export async function handleDeleteTenantAccount(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const jwt = getBearerToken(request);
  const user = await getVerifiedUser(env, jwt);
  if (!user || user.isAnonymous) {
    return new Response(JSON.stringify({ error: "invalid or expired session" }), { status: 401 });
  }

  const membership = await getOwnerMembership(env, user.id);
  if (!membership) {
    return new Response(JSON.stringify({ error: "no tenant found for this account" }), { status: 403 });
  }
  // Every role today is already 'owner' or 'admin' (see the check constraint on
  // tenant_members.role) -- this check is here so a future, less-privileged role
  // (e.g. a read-only member) can never delete the account just by omission.
  if (membership.role !== "owner" && membership.role !== "admin") {
    return new Response(JSON.stringify({ error: "only an owner or admin can delete this account" }), { status: 403 });
  }

  let body: DeleteAccountBody;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid JSON body" }), { status: 400 });
  }
  if (body.confirmation !== CONFIRMATION_PHRASE) {
    return new Response(JSON.stringify({ error: `type "${CONFIRMATION_PHRASE}" to confirm` }), { status: 400 });
  }

  const service = getServiceClient(env);
  const { error } = await service.rpc("delete_tenant_account", { p_tenant_id: membership.tenantId });
  if (error) {
    return new Response(JSON.stringify({ error: "failed to delete account" }), { status: 500 });
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
