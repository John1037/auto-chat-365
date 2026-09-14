import type { Env } from "../lib/env";
import { getServiceClient, getVerifiedUserId, getBearerToken } from "../lib/supabase";
import { isOriginAllowed } from "../lib/cors";

const HISTORY_LIMIT = 50;

// Lets the widget redisplay a returning visitor's existing conversation on load,
// instead of always starting from just the greeting -- read-only counterpart to
// chat.ts's own history lookup, which only ever fed messages to the LLM, never back
// to the client. Same auth/origin checks as chat.ts, since this is still a
// cross-origin authenticated call carrying a visitor's own conversation content.
export async function handleConversationHistory(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") {
    return new Response("Method not allowed", { status: 405 });
  }

  const origin = request.headers.get("Origin");
  const jwt = getBearerToken(request);
  const callerId = await getVerifiedUserId(env, jwt);
  if (!callerId) {
    return new Response(JSON.stringify({ error: "invalid or expired session" }), { status: 401 });
  }

  const service = getServiceClient(env);
  const { data: session, error: sessionError } = await service
    .from("widget_sessions")
    .select("tenant_id, widget_id, revoked")
    .eq("id", callerId)
    .maybeSingle();
  if (sessionError || !session || session.revoked) {
    return new Response(JSON.stringify({ error: "session not found or revoked" }), { status: 401 });
  }

  const { data: widget, error: widgetError } = await service
    .from("widgets")
    .select("allowed_origins")
    .eq("id", session.widget_id)
    .maybeSingle();
  if (widgetError || !widget) {
    return new Response(JSON.stringify({ error: "widget not found" }), { status: 404 });
  }
  if (!isOriginAllowed(origin, widget.allowed_origins)) {
    return new Response(JSON.stringify({ error: "origin not allowed for this widget" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }

  // A session accumulates a new conversation only when its previous one goes stale
  // (see chat.ts) -- picking the most recently created one is always the visitor's
  // current, ongoing conversation.
  const { data: conversation, error: convError } = await service
    .from("conversations")
    .select("id")
    .eq("session_id", callerId)
    .eq("tenant_id", session.tenant_id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (convError) {
    return new Response(JSON.stringify({ error: "failed to look up conversation" }), { status: 500 });
  }
  if (!conversation) {
    return new Response(JSON.stringify({ conversation_id: null, messages: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  const { data: messages, error: messagesError } = await service
    .from("messages")
    .select("role, content")
    .eq("conversation_id", conversation.id)
    .order("created_at", { ascending: true })
    .limit(HISTORY_LIMIT);
  if (messagesError) {
    return new Response(JSON.stringify({ error: "failed to load messages" }), { status: 500 });
  }

  return new Response(JSON.stringify({ conversation_id: conversation.id, messages }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
