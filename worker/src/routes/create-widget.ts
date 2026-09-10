import type { Env } from "../lib/env";
import { getServiceClient, getVerifiedUser, getBearerToken } from "../lib/supabase";

interface CreateWidgetBody {
  name?: string;
}

// Same pattern as tenant-provision/ingest-document: tenant_id is derived server-side
// from tenant_members by the caller's verified auth.uid(), never trusted from the
// request body. site_key/position/color_scheme/etc. all come from column defaults.
export async function handleCreateWidget(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const jwt = getBearerToken(request);
  const user = await getVerifiedUser(env, jwt);
  if (!user) {
    return new Response(JSON.stringify({ error: "invalid or expired session" }), { status: 401 });
  }
  if (user.isAnonymous) {
    return new Response(JSON.stringify({ error: "anonymous sessions cannot create widgets" }), { status: 403 });
  }

  let body: CreateWidgetBody;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid JSON body" }), { status: 400 });
  }
  const name = body.name?.trim();

  const service = getServiceClient(env);

  const { data: membership, error: membershipError } = await service
    .from("tenant_members")
    .select("tenant_id")
    .eq("user_id", user.id)
    .maybeSingle();
  if (membershipError || !membership) {
    return new Response(JSON.stringify({ error: "no tenant found for this account" }), { status: 404 });
  }

  const { data: widget, error: widgetError } = await service
    .from("widgets")
    .insert({ tenant_id: membership.tenant_id, ...(name ? { name } : {}) })
    .select("id, name, site_key, allowed_origins, created_at")
    .single();
  if (widgetError || !widget) {
    return new Response(JSON.stringify({ error: "failed to create widget" }), { status: 500 });
  }

  return new Response(JSON.stringify({ widget }), {
    status: 201,
    headers: { "Content-Type": "application/json" },
  });
}
