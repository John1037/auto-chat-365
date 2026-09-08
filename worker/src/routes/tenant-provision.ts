import type { Env } from "../lib/env";

// Implemented in M4: one-time call for a freshly signed-up owner (real Supabase Auth
// user, not a widget visitor) -- creates the tenants row + first
// tenant_members(role='owner') row via the privileged client.
export async function handleTenantProvision(_request: Request, _env: Env): Promise<Response> {
  return new Response(JSON.stringify({ error: "not implemented yet" }), {
    status: 501,
    headers: { "Content-Type": "application/json" },
  });
}
