import type { Env } from "../lib/env";
import { getServiceClient, getVerifiedUser, getBearerToken } from "../lib/supabase";
import { getOwnerTenantId } from "../lib/tenantOwner";

interface UpdateBody {
  document_id?: string;
  title?: string;
  content?: string;
}

// Editing only ever changes the stored title/content and marks the document stale
// if it had already been embedded -- it never touches tenant_document_chunks
// itself. Re-embedding (a separate route) is what actually catches the chunks up
// to the new content; that's a deliberate two-step split, not an oversight, so an
// owner can edit multiple times before paying for a re-embed.
export async function handleUpdateDocument(request: Request, env: Env): Promise<Response> {
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

  let body: UpdateBody;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid JSON body" }), { status: 400 });
  }
  const title = body.title?.trim();
  const content = body.content?.trim();
  if (!body.document_id || !title || !content) {
    return new Response(JSON.stringify({ error: "document_id, title, and content are required" }), { status: 400 });
  }

  const service = getServiceClient(env);

  const { data: existing, error: fetchError } = await service
    .from("tenant_documents")
    .select("status")
    .eq("id", body.document_id)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (fetchError || !existing) {
    return new Response(JSON.stringify({ error: "document not found" }), { status: 404 });
  }

  const nextStatus = existing.status === "ready" || existing.status === "stale" ? "stale" : existing.status;

  const { error: updateError } = await service
    .from("tenant_documents")
    .update({ title, raw_content: content, status: nextStatus })
    .eq("id", body.document_id)
    .eq("tenant_id", tenantId);
  if (updateError) {
    return new Response(JSON.stringify({ error: "update failed" }), { status: 500 });
  }

  return new Response(JSON.stringify({ ok: true, status: nextStatus }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
