import type { Env } from "../lib/env";
import { getServiceClient, getVerifiedUser, getBearerToken } from "../lib/supabase";
import { getOwnerTenantId } from "../lib/tenantOwner";
import { embedAndStoreDocument } from "../lib/embedDocument";
import { verifyOwnedWidgetIds } from "../lib/widgetVisibility";

interface IngestBody {
  title?: string;
  content?: string;
  is_global?: boolean;
  widget_ids?: string[];
}

export async function handleIngestDocument(request: Request, env: Env): Promise<Response> {
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

  let body: IngestBody;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid JSON body" }), { status: 400 });
  }
  const title = body.title?.trim();
  const content = body.content?.trim();
  if (!title || !content) {
    return new Response(JSON.stringify({ error: "title and content are required" }), { status: 400 });
  }
  const isGlobal = body.is_global !== false;

  const service = getServiceClient(env);
  const ownedWidgetIds = isGlobal ? [] : await verifyOwnedWidgetIds(service, tenantId, body.widget_ids ?? []);

  const { data: document, error: insertError } = await service
    .from("tenant_documents")
    .insert({
      tenant_id: tenantId,
      title,
      source_type: "text",
      raw_content: content,
      status: "processing",
      created_by: user.id,
      is_global: isGlobal,
    })
    .select("id")
    .single();
  if (insertError || !document) {
    return new Response(JSON.stringify({ error: "failed to create document" }), { status: 500 });
  }

  const result = await embedAndStoreDocument(env, service, tenantId, document.id, content);
  if (!result.ok) {
    return new Response(JSON.stringify({ error: result.error, document_id: document.id }), { status: 502 });
  }

  if (ownedWidgetIds.length > 0) {
    const { error: linkError } = await service
      .from("widget_documents")
      .insert(ownedWidgetIds.map((widgetId) => ({ widget_id: widgetId, document_id: document.id })));
    if (linkError) {
      // The document itself already embedded successfully -- failing safe to
      // visible-everywhere beats leaving it silently invisible to every widget.
      await service.from("tenant_documents").update({ is_global: true }).eq("id", document.id);
    }
  }

  return new Response(JSON.stringify({ document_id: document.id }), {
    status: 201,
    headers: { "Content-Type": "application/json" },
  });
}
