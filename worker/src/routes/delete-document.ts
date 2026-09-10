import type { Env } from "../lib/env";
import { getServiceClient, getVerifiedUser, getBearerToken } from "../lib/supabase";
import { getOwnerTenantId } from "../lib/tenantOwner";

interface DeleteBody {
  document_id?: string;
}

export async function handleDeleteDocument(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const jwt = getBearerToken(request);
  const user = await getVerifiedUser(env, jwt);
  if (!user || user.isAnonymous) {
    return new Response(JSON.stringify({ error: "invalid or expired session" }), { status: 401 });
  }

  const tenantId = await getOwnerTenantId(env, user.id);
  if (!tenantId) {
    return new Response(JSON.stringify({ error: "no tenant found for this account" }), { status: 403 });
  }

  let body: DeleteBody;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid JSON body" }), { status: 400 });
  }
  if (!body.document_id) {
    return new Response(JSON.stringify({ error: "document_id is required" }), { status: 400 });
  }

  const service = getServiceClient(env);

  // Explicit tenant_id match in the delete filter -- the service client bypasses
  // RLS, so this is the actual check that stops an owner deleting another
  // tenant's document by guessing/reusing an id.
  const { data: deleted, error } = await service
    .from("tenant_documents")
    .delete()
    .eq("id", body.document_id)
    .eq("tenant_id", tenantId)
    .select("id")
    .maybeSingle();

  if (error) {
    return new Response(JSON.stringify({ error: "delete failed" }), { status: 500 });
  }
  if (!deleted) {
    return new Response(JSON.stringify({ error: "document not found" }), { status: 404 });
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
