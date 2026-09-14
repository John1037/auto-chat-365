import type { Env } from "./lib/env";
import { corsPreflightResponse, withCorsHeaders } from "./lib/cors";
import { handleSessionStart } from "./routes/session-start";
import { handleChat } from "./routes/chat";
import { handleIngestDocument } from "./routes/ingest-document";
import { handleIngestDocumentFiles } from "./routes/ingest-document-files";
import { handleDeleteDocument } from "./routes/delete-document";
import { handleUpdateDocument } from "./routes/update-document";
import { handleUpdateDocumentVisibility } from "./routes/update-document-visibility";
import { handleReembedDocument } from "./routes/reembed-document";
import { handleTenantProvision } from "./routes/tenant-provision";
import { handleCreateWidget } from "./routes/create-widget";
import { handleWidgetConfig } from "./routes/widget-config";
import { handleUploadWidgetLogo } from "./routes/upload-widget-logo";
import { handleUploadWidgetAvatar } from "./routes/upload-widget-avatar";

async function routeApiRequest(pathname: string, request: Request, env: Env): Promise<Response> {
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
    case "/api/ingest-document-files":
      return handleIngestDocumentFiles(request, env);
    case "/api/delete-document":
      return handleDeleteDocument(request, env);
    case "/api/update-document":
      return handleUpdateDocument(request, env);
    case "/api/update-document-visibility":
      return handleUpdateDocumentVisibility(request, env);
    case "/api/reembed-document":
      return handleReembedDocument(request, env);
    case "/api/tenant-provision":
      return handleTenantProvision(request, env);
    case "/api/create-widget":
      return handleCreateWidget(request, env);
    case "/api/widget-config":
      return handleWidgetConfig(request, env);
    case "/api/upload-widget-logo":
      return handleUploadWidgetLogo(request, env);
    case "/api/upload-widget-avatar":
      return handleUploadWidgetAvatar(request, env);
    default:
      return new Response("Not found", { status: 404 });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (pathname.startsWith("/api/")) {
      if (request.method === "OPTIONS") {
        return corsPreflightResponse(request);
      }

      // Applied here, once, to every /api/* response -- not left to each route to
      // remember on every branch. A route can 401/403/404/500 from a dozen different
      // early returns; missing this on even one means a real browser's fetch() rejects
      // that response with a generic "Failed to fetch" (CORS failures are invisible to
      // curl, which doesn't enforce CORS at all, so this class of bug can look fully
      // verified via curl while being broken for every real cross-origin caller).
      const origin = request.headers.get("Origin") ?? "*";
      const response = await routeApiRequest(pathname, request, env);
      return withCorsHeaders(response, origin);
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
