import type { Env } from "../lib/env";
import { getServiceClient } from "../lib/supabase";
import { isOriginAllowed, withCorsHeaders } from "../lib/cors";
import { checkRateLimit } from "../lib/rateLimit";

interface SessionStartBody {
  site_key?: string;
}

// Mints a fresh anonymous visitor session scoped to one widget (and, denormalized,
// its tenant). This is the *initial* mint only -- once the widget holds a
// refresh_token, resuming the session across page loads is the widget's own job via
// supabase-js's normal refresh flow, not another call to this route. Keeping those
// concerns separate avoids a half-built "resume via server" path that would just
// re-implement what supabase-js already does client-side.
export async function handleSessionStart(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const origin = request.headers.get("Origin");
  let body: SessionStartBody;
  try {
    body = await request.json();
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }

  const siteKey = body.site_key;
  if (!siteKey) {
    return new Response(JSON.stringify({ error: "site_key is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const service = getServiceClient(env);

  const { data: widget, error: widgetError } = await service
    .from("widgets")
    .select("id, tenant_id, allowed_origins, rate_limit_per_minute, tenants!inner(is_active)")
    .eq("site_key", siteKey)
    .maybeSingle();

  if (widgetError) {
    return new Response(JSON.stringify({ error: "lookup failed" }), { status: 500 });
  }
  const tenant = widget?.tenants as unknown as { is_active: boolean } | undefined;
  if (!widget || !tenant?.is_active) {
    return new Response(JSON.stringify({ error: "unknown or inactive widget" }), { status: 404 });
  }

  if (!isOriginAllowed(origin, widget.allowed_origins)) {
    return new Response(JSON.stringify({ error: "origin not allowed for this widget" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }

  const withinLimit = await checkRateLimit(
    service,
    widget.tenant_id,
    "tenant",
    `session-start:${widget.id}`,
    60,
    widget.rate_limit_per_minute,
  );
  if (!withinLimit) {
    const resp = new Response(JSON.stringify({ error: "rate limit exceeded" }), {
      status: 429,
      headers: { "Content-Type": "application/json" },
    });
    return withCorsHeaders(resp, origin!);
  }

  // A dedicated, single-use client for the sign-in call: calling .auth.signInAnonymously()
  // on a client mutates that client's own session context, so subsequent .from() calls
  // on the SAME instance would authenticate as the new anonymous (authenticated-role)
  // user instead of staying service_role -- fatal for the widget_sessions insert below,
  // which needs to bypass RLS. `service` is never touched by auth calls, so it stays
  // service_role for the rest of this handler.
  const authClient = getServiceClient(env);
  const { data: signInData, error: signInError } = await authClient.auth.signInAnonymously();
  if (signInError || !signInData.session || !signInData.user) {
    return new Response(JSON.stringify({ error: "failed to start session" }), { status: 500 });
  }

  const { error: upsertError } = await service.from("widget_sessions").insert({
    id: signInData.user.id,
    tenant_id: widget.tenant_id,
    widget_id: widget.id,
    origin,
    user_agent: request.headers.get("User-Agent"),
  });
  if (upsertError) {
    return new Response(JSON.stringify({ error: "failed to persist session" }), { status: 500 });
  }

  // The Custom Access Token Hook fires at token issuance -- i.e. during
  // signInAnonymously() above, *before* the widget_sessions row it looks up existed.
  // The initial session's access_token therefore carries no tenant_id claim. Forcing
  // a refresh now re-triggers the hook with the row in place, so the token we
  // actually return to the client is the one with tenant_id injected.
  const { data: refreshed, error: refreshError } = await authClient.auth.refreshSession({
    refresh_token: signInData.session.refresh_token,
  });
  if (refreshError || !refreshed.session) {
    return new Response(JSON.stringify({ error: "failed to finalize session" }), { status: 500 });
  }

  const resp = new Response(
    JSON.stringify({
      access_token: refreshed.session.access_token,
      refresh_token: refreshed.session.refresh_token,
      expires_at: refreshed.session.expires_at,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
  return withCorsHeaders(resp, origin!);
}
