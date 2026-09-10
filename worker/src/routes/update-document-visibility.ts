import type { Env } from "../lib/env";
import { getServiceClient, getVerifiedUser, getBearerToken } from "../lib/supabase";
import { getOwnerTenantId } from "../lib/tenantOwner";

interface UpdateVisibilityBody {
  document_id?: string;
  is_global?: boolean;
  widget_ids?: string[];
}

// Sets which widgets can see a document: either every widget (is_global) or an
// explicit list (widget_documents). match_tenant_document_chunks (see
// 0008_multi_widget.sql) already reads both at retrieval time -- this route is the
// only thing that writes them. Always replaces the full widget_ids set from scratch
// rather than diffing, same "just overwrite" simplicity as allowed_origins edits.
export async function handleUpdateDocumentVisibility(request: Request, env: Env): Promise<Response> {
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

  let body: UpdateVisibilityBody;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid JSON body" }), { status: 400 });
  }
  if (!body.document_id || typeof body.is_global !== "boolean") {
    return new Response(JSON.stringify({ error: "document_id and is_global are required" }), { status: 400 });
  }
  const widgetIds = body.is_global ? [] : (body.widget_ids ?? []);

  const service = getServiceClient(env);

  const { data: document, error: fetchError } = await service
    .from("tenant_documents")
    .select("id")
    .eq("id", body.document_id)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (fetchError || !document) {
    return new Response(JSON.stringify({ error: "document not found" }), { status: 404 });
  }

  // Only ever link widgets that actually belong to this tenant -- widgetIds comes
  // from the client, so a stray/forged id must be silently dropped, not trusted.
  let ownedWidgetIds: string[] = [];
  if (widgetIds.length > 0) {
    const { data: widgets, error: widgetsError } = await service
      .from("widgets")
      .select("id")
      .eq("tenant_id", tenantId)
      .in("id", widgetIds);
    if (widgetsError) {
      return new Response(JSON.stringify({ error: "failed to verify widgets" }), { status: 500 });
    }
    ownedWidgetIds = (widgets ?? []).map((w) => w.id as string);
  }

  const { error: updateError } = await service
    .from("tenant_documents")
    .update({ is_global: body.is_global })
    .eq("id", body.document_id)
    .eq("tenant_id", tenantId);
  if (updateError) {
    return new Response(JSON.stringify({ error: "failed to update document" }), { status: 500 });
  }

  const { error: deleteError } = await service.from("widget_documents").delete().eq("document_id", body.document_id);
  if (deleteError) {
    return new Response(JSON.stringify({ error: "failed to clear existing widget links" }), { status: 500 });
  }

  if (ownedWidgetIds.length > 0) {
    const { error: insertError } = await service
      .from("widget_documents")
      .insert(ownedWidgetIds.map((widgetId) => ({ widget_id: widgetId, document_id: body.document_id })));
    if (insertError) {
      return new Response(JSON.stringify({ error: "failed to link widgets" }), { status: 500 });
    }
  }

  return new Response(JSON.stringify({ ok: true, is_global: body.is_global, widget_ids: ownedWidgetIds }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
