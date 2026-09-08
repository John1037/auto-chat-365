import type { Env } from "../lib/env";

// Implemented in M4: chunk + embed a tenant-owner-submitted document into
// tenant_document_chunks via the privileged client, after deriving tenant_id from
// tenant_members by the caller's verified auth.uid() (never a client-supplied id).
export async function handleIngestDocument(_request: Request, _env: Env): Promise<Response> {
  return new Response(JSON.stringify({ error: "not implemented yet" }), {
    status: 501,
    headers: { "Content-Type": "application/json" },
  });
}
