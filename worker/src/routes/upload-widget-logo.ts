import type { Env } from "../lib/env";
import { getServiceClient, getVerifiedUser, getBearerToken } from "../lib/supabase";
import { getOwnerTenantId } from "../lib/tenantOwner";

const MAX_BYTES = 2 * 1024 * 1024; // 2MB, matches the bucket's own file_size_limit -- defense in depth, not trusting Storage alone
const ALLOWED_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/svg+xml"]);

// Stores at a fixed path per widget (no extension -- content-type is set explicitly
// on upload, so nothing downstream needs the path to carry one) with upsert:true, so
// re-uploading a new logo always overwrites the same object instead of accumulating
// orphaned files under different extensions.
export async function handleUploadWidgetLogo(request: Request, env: Env): Promise<Response> {
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

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return new Response(JSON.stringify({ error: "invalid form data" }), { status: 400 });
  }

  const widgetId = formData.get("widget_id");
  const file = formData.get("file");
  if (typeof widgetId !== "string" || !widgetId) {
    return new Response(JSON.stringify({ error: "widget_id is required" }), { status: 400 });
  }
  if (typeof file === "string" || !file) {
    return new Response(JSON.stringify({ error: "file is required" }), { status: 400 });
  }
  if (!ALLOWED_TYPES.has(file.type)) {
    return new Response(JSON.stringify({ error: "unsupported image type" }), { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return new Response(JSON.stringify({ error: "image is too large (2MB max)" }), { status: 400 });
  }

  const service = getServiceClient(env);

  const { data: widget, error: fetchError } = await service
    .from("widgets")
    .select("id")
    .eq("id", widgetId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (fetchError || !widget) {
    return new Response(JSON.stringify({ error: "widget not found" }), { status: 404 });
  }

  const path = `${widgetId}/logo`;
  const { error: uploadError } = await service.storage
    .from("widget-logos")
    .upload(path, await file.arrayBuffer(), { contentType: file.type, upsert: true });
  if (uploadError) {
    return new Response(JSON.stringify({ error: "upload failed" }), { status: 500 });
  }

  // Cache-busted so the widget (which may have cached the previous image by URL)
  // picks up a replacement logo immediately rather than needing a hard refresh.
  const logoUrl = `${env.SUPABASE_URL}/storage/v1/object/public/widget-logos/${path}?v=${Date.now()}`;

  const { error: updateError } = await service.from("widgets").update({ logo_url: logoUrl }).eq("id", widgetId).eq("tenant_id", tenantId);
  if (updateError) {
    return new Response(JSON.stringify({ error: "failed to save logo" }), { status: 500 });
  }

  return new Response(JSON.stringify({ logo_url: logoUrl }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
