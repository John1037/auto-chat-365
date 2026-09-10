import type { Env } from "../lib/env";
import { getServiceClient, getVerifiedUser, getBearerToken } from "../lib/supabase";
import { getOwnerTenantId } from "../lib/tenantOwner";
import { embedAndStoreDocument } from "../lib/embedDocument";

interface ReembedBody {
  document_id?: string;
}

export async function handleReembedDocument(request: Request, env: Env): Promise<Response> {
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

  let body: ReembedBody;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid JSON body" }), { status: 400 });
  }
  if (!body.document_id) {
    return new Response(JSON.stringify({ error: "document_id is required" }), { status: 400 });
  }

  const service = getServiceClient(env);

  const { data: document, error: fetchError } = await service
    .from("tenant_documents")
    .select("raw_content")
    .eq("id", body.document_id)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (fetchError || !document || !document.raw_content) {
    return new Response(JSON.stringify({ error: "document not found" }), { status: 404 });
  }

  const result = await embedAndStoreDocument(env, service, tenantId, body.document_id, document.raw_content);
  if (!result.ok) {
    return new Response(JSON.stringify({ error: result.error }), { status: 502 });
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
