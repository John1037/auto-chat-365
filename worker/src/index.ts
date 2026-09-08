import type { Env } from "./lib/env";
import { corsPreflightResponse } from "./lib/cors";
import { handleSessionStart } from "./routes/session-start";
import { handleChat } from "./routes/chat";
import { handleIngestDocument } from "./routes/ingest-document";
import { handleDeleteDocument } from "./routes/delete-document";
import { handleTenantProvision } from "./routes/tenant-provision";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (pathname.startsWith("/api/")) {
      if (request.method === "OPTIONS") {
        return corsPreflightResponse(request);
      }

      switch (pathname) {
        case "/api/session-start":
          return handleSessionStart(request, env);
        case "/api/chat":
          return handleChat(request, env);
        case "/api/ingest-document":
          return handleIngestDocument(request, env);
        case "/api/delete-document":
          return handleDeleteDocument(request, env);
        case "/api/tenant-provision":
          return handleTenantProvision(request, env);
        default:
          return new Response("Not found", { status: 404 });
      }
    }

    // run_worker_first is scoped to /api/* in wrangler.jsonc, so normal traffic never
    // reaches here -- this is a safety fallback, not the primary asset-serving path.
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
