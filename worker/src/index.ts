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
        case "/api/config":
          // Both values are meant to be public -- the publishable key is designed to
          // be exposed client-side, same as the URL. This lets the static site pages
          // (login.html/dashboard.html) initialize supabase-js without hardcoding
          // which Supabase project to talk to at build time.
          return Response.json({
            supabaseUrl: env.SUPABASE_URL,
            supabasePublishableKey: env.SUPABASE_PUBLISHABLE_KEY,
          });
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

    // html_handling is "none" (see wrangler.jsonc) so that /login.html and
    // /dashboard.html serve as their literal filenames rather than Cloudflare's
    // default of 307-redirecting them to /login and /dashboard -- but that setting
    // also disables the usual "/" -> "/index.html" mapping as a side effect, so "/"
    // is listed in run_worker_first and handled explicitly here.
    if (pathname === "/") {
      return env.ASSETS.fetch(new Request(new URL("/index.html", request.url), request));
    }

    // run_worker_first is otherwise scoped to /api/* in wrangler.jsonc, so normal
    // asset traffic never reaches here -- this is a safety fallback, not the primary
    // asset-serving path.
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
