import type { Env } from "../lib/env";
import { getServiceClient, getVerifiedUser, getBearerToken } from "../lib/supabase";

// Get-or-create: called every time an owner lands on the dashboard after a magic-link
// sign-in, not just the first time (magic link makes "signup" and "login" the same
// action, so there's no separate first-time-only moment to hook). Idempotent by
// design -- a returning owner just gets their existing tenant (and its default
// widget) back. site_key/allowed_origins/rate limits live on widgets now, not
// tenants -- a tenant can have more than one -- so provisioning a brand-new tenant
// also creates its first ("Default widget") widget.
export async function handleTenantProvision(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const jwt = getBearerToken(request);
  const user = await getVerifiedUser(env, jwt);
  if (!user) {
    return new Response(JSON.stringify({ error: "invalid or expired session" }), { status: 401 });
  }
  // Widget visitor sessions (signInAnonymously) must never be able to provision a
  // tenant -- only a real, non-anonymous owner account.
  if (user.isAnonymous) {
    return new Response(JSON.stringify({ error: "anonymous sessions cannot provision a tenant" }), { status: 403 });
  }

  const service = getServiceClient(env);

  const { data: existingMembership, error: membershipError } = await service
    .from("tenant_members")
    .select("tenant_id, tenants (id, name)")
    .eq("user_id", user.id)
    .maybeSingle();

  if (membershipError) {
    return new Response(JSON.stringify({ error: "lookup failed" }), { status: 500 });
  }
  if (existingMembership) {
    const { data: widgets, error: widgetsError } = await service
      .from("widgets")
      .select("id, name, site_key, allowed_origins")
      .eq("tenant_id", existingMembership.tenant_id)
      .order("created_at", { ascending: true });
    if (widgetsError) {
      return new Response(JSON.stringify({ error: "lookup failed" }), { status: 500 });
    }
    return new Response(JSON.stringify({ tenant: existingMembership.tenants, widget: widgets?.[0] ?? null }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  const defaultName = user.email ? `${user.email.split("@")[0]}'s workspace` : "My workspace";

  const { data: tenant, error: tenantError } = await service
    .from("tenants")
    .insert({ name: defaultName })
    .select("id, name")
    .single();
  if (tenantError || !tenant) {
    return new Response(JSON.stringify({ error: "failed to create tenant" }), { status: 500 });
  }

  const { error: memberError } = await service.from("tenant_members").insert({
    tenant_id: tenant.id,
    user_id: user.id,
    role: "owner",
  });
  if (memberError) {
    return new Response(JSON.stringify({ error: "failed to attach owner" }), { status: 500 });
  }

  const { data: widget, error: widgetError } = await service
    .from("widgets")
    .insert({ tenant_id: tenant.id })
    .select("id, name, site_key, allowed_origins")
    .single();
  if (widgetError || !widget) {
    return new Response(JSON.stringify({ error: "failed to create default widget" }), { status: 500 });
  }

  return new Response(JSON.stringify({ tenant, widget }), {
    status: 201,
    headers: { "Content-Type": "application/json" },
  });
}
