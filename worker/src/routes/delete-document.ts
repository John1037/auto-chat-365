import type { Env } from "../lib/env";

// Implemented in M4: verify tenant_members membership + the document's tenant_id
// match before deleting via the privileged client (cascades to its chunks).
export async function handleDeleteDocument(_request: Request, _env: Env): Promise<Response> {
  return new Response(JSON.stringify({ error: "not implemented yet" }), {
    status: 501,
    headers: { "Content-Type": "application/json" },
  });
}
