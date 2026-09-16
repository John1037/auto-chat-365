import type { Env } from "../lib/env";
import { getServiceClient, getVerifiedUser, getBearerToken } from "../lib/supabase";
import { getOwnerMembership } from "../lib/tenantOwner";

interface UpdateRetentionBody {
  retention_months?: number;
}

// tenants' own RLS only allows a direct PostgREST UPDATE from role='owner' (see
// tenants_owner_update in migration 0004) -- same as delete-tenant-account, this
// goes through a dedicated route with its own explicit owner-or-admin check instead
// of broadening that policy, so an admin can change this consequential,
// data-loss-affecting setting without changing what else that RLS policy allows.
export async function handleUpdateRetentionPolicy(request: Request, env: Env): Promise<Response> {
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
  if (membership.role !== "owner" && membership.role !== "admin") {
    return new Response(JSON.stringify({ error: "only an owner or admin can change this setting" }), { status: 403 });
  }

  let body: UpdateRetentionBody;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid JSON body" }), { status: 400 });
  }
  const months = body.retention_months;
  if (typeof months !== "number" || !Number.isInteger(months) || months < 1 || months > 24) {
    return new Response(JSON.stringify({ error: "retention_months must be a whole number between 1 and 24" }), { status: 400 });
  }

  const service = getServiceClient(env);
  const { error } = await service
    .from("tenants")
    .update({ conversation_retention_months: months })
    .eq("id", membership.tenantId);
  if (error) {
    return new Response(JSON.stringify({ error: "failed to save retention policy" }), { status: 500 });
  }

  return new Response(JSON.stringify({ ok: true, retention_months: months }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
