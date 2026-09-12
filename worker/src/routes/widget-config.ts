import type { Env } from "../lib/env";
import { getServiceClient } from "../lib/supabase";
import { isOriginAllowed, withCorsHeaders } from "../lib/cors";

// Public, unauthenticated (there is no visitor session yet at this point -- the
// embed script needs its display settings before it even has a reason to mint one
// via session-start). Nothing returned here is sensitive: it's the same look tenant
// mints into its own page's HTML. Origin is still checked against allowed_origins so
// a widget's settings aren't readable from a domain it isn't embedded on.
export async function handleWidgetConfig(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") {
    return new Response("Method not allowed", { status: 405 });
  }

  const origin = request.headers.get("Origin");
  const siteKey = new URL(request.url).searchParams.get("site_key");
  if (!siteKey) {
    return new Response(JSON.stringify({ error: "site_key is required" }), { status: 400 });
  }

  const service = getServiceClient(env);
  const { data: widget, error } = await service
    .from("widgets")
    .select(
      "allowed_origins, chatbot_name, color_scheme, chat_title, position, offset_x, offset_y, logo_url, header_color, theme, greeting_message, tenants!inner(is_active)",
    )
    .eq("site_key", siteKey)
    .maybeSingle();

  const tenant = widget?.tenants as unknown as { is_active: boolean } | undefined;
  if (error || !widget || !tenant?.is_active) {
    return new Response(JSON.stringify({ error: "unknown or inactive widget" }), { status: 404 });
  }

  if (!isOriginAllowed(origin, widget.allowed_origins)) {
    return new Response(JSON.stringify({ error: "origin not allowed for this widget" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }

  const resp = new Response(
    JSON.stringify({
      chatbot_name: widget.chatbot_name,
      color_scheme: widget.color_scheme,
      chat_title: widget.chat_title,
      position: widget.position,
      offset_x: widget.offset_x,
      offset_y: widget.offset_y,
      logo_url: widget.logo_url,
      header_color: widget.header_color,
      theme: widget.theme,
      greeting_message: widget.greeting_message,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
  return withCorsHeaders(resp, origin!);
}
