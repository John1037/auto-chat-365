import type { Env } from "../lib/env";
import { getServiceClient, getVerifiedUserId, getBearerToken } from "../lib/supabase";
import { isOriginAllowed, withCorsHeaders } from "../lib/cors";
import { checkRateLimit } from "../lib/rateLimit";
import { embedText } from "../lib/openai";
import { deepseekChat, type ChatMessage } from "../lib/deepseek";

interface ChatBody {
  message?: string;
  conversation_id?: string;
}

const RETRIEVAL_LIMIT = 5;
const HISTORY_LIMIT = 10;
const SESSION_RATE_WINDOW_SECONDS = 60;
const SESSION_RATE_LIMIT = 20;
const DAILY_RATE_WINDOW_SECONDS = 86400;

// The chat round trip: verify the visitor, re-derive their tenant from our own
// records (never from the JWT claim alone), retrieve tenant-scoped context, call the
// LLM, and persist both sides of the exchange.
export async function handleChat(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const origin = request.headers.get("Origin");
  const jwt = getBearerToken(request);
  const callerId = await getVerifiedUserId(env, jwt);
  if (!callerId) {
    return new Response(JSON.stringify({ error: "invalid or expired session" }), { status: 401 });
  }

  const service = getServiceClient(env);

  // Defense in depth beyond RLS: derive tenant_id from our own widget_sessions row,
  // not from the JWT's tenant_id claim, in case the Custom Access Token Hook ever
  // has a bug or the session has since been revoked.
  const { data: session, error: sessionError } = await service
    .from("widget_sessions")
    .select("tenant_id, revoked")
    .eq("id", callerId)
    .maybeSingle();

  if (sessionError || !session || session.revoked) {
    return new Response(JSON.stringify({ error: "session not found or revoked" }), { status: 401 });
  }

  const tenantId = session.tenant_id as string;

  const { data: tenant, error: tenantError } = await service
    .from("tenants")
    .select("allowed_origins, rate_limit_per_minute, rate_limit_daily, is_active")
    .eq("id", tenantId)
    .maybeSingle();

  if (tenantError || !tenant || !tenant.is_active) {
    return new Response(JSON.stringify({ error: "tenant not found or inactive" }), { status: 404 });
  }

  if (!isOriginAllowed(origin, tenant.allowed_origins)) {
    return new Response(JSON.stringify({ error: "origin not allowed for this tenant" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }

  const [withinSessionLimit, withinTenantLimit, withinDailyLimit] = await Promise.all([
    checkRateLimit(service, tenantId, "session", callerId, SESSION_RATE_WINDOW_SECONDS, SESSION_RATE_LIMIT),
    checkRateLimit(service, tenantId, "tenant", "chat", 60, tenant.rate_limit_per_minute),
    checkRateLimit(service, tenantId, "tenant", "chat-daily", DAILY_RATE_WINDOW_SECONDS, tenant.rate_limit_daily),
  ]);
  if (!withinSessionLimit || !withinTenantLimit || !withinDailyLimit) {
    const resp = new Response(JSON.stringify({ error: "rate limit exceeded" }), {
      status: 429,
      headers: { "Content-Type": "application/json" },
    });
    return withCorsHeaders(resp, origin!);
  }

  let body: ChatBody;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid JSON body" }), { status: 400 });
  }
  const message = body.message?.trim();
  if (!message) {
    return new Response(JSON.stringify({ error: "message is required" }), { status: 400 });
  }

  // Resolve or create the conversation, always under an explicit tenant_id/session_id
  // filter -- the service client bypasses RLS, so this filter *is* the enforcement.
  let conversationId = body.conversation_id;
  if (conversationId) {
    const { data: existing, error: convError } = await service
      .from("conversations")
      .select("id")
      .eq("id", conversationId)
      .eq("tenant_id", tenantId)
      .eq("session_id", callerId)
      .maybeSingle();
    if (convError || !existing) {
      return new Response(JSON.stringify({ error: "conversation not found" }), { status: 404 });
    }
  } else {
    const { data: created, error: createError } = await service
      .from("conversations")
      .insert({ tenant_id: tenantId, session_id: callerId })
      .select("id")
      .single();
    if (createError || !created) {
      return new Response(JSON.stringify({ error: "failed to start conversation" }), { status: 500 });
    }
    conversationId = created.id;
  }

  const { data: history } = await service
    .from("messages")
    .select("role, content")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(HISTORY_LIMIT);

  const { error: userInsertError } = await service.from("messages").insert({
    conversation_id: conversationId,
    tenant_id: tenantId,
    session_id: callerId,
    role: "user",
    content: message,
  });
  if (userInsertError) {
    return new Response(JSON.stringify({ error: "failed to save message" }), { status: 500 });
  }

  // Retrieval: no-op until ingest-document (M4) exists and tenant_document_chunks has
  // rows. embedText is still called so the round trip is exercised end-to-end now,
  // but the retrieved context is only wired into the prompt once ingestion lands.
  let retrievedContext = "";
  try {
    const queryEmbedding = await embedText(env, message);
    const { data: chunks } = await service.rpc("match_tenant_document_chunks", {
      p_tenant_id: tenantId,
      p_query_embedding: queryEmbedding,
      p_match_count: RETRIEVAL_LIMIT,
    });
    if (chunks?.length) {
      retrievedContext = chunks.map((c: { content: string }) => c.content).join("\n---\n");
    }
  } catch {
    // match_tenant_document_chunks doesn't exist until M4's ingestion migration lands
    // -- treat retrieval as best-effort, never fail the chat turn because of it.
  }

  const systemPrompt = retrievedContext
    ? `You are a helpful assistant for this business. Answer using only the following context when relevant:\n${retrievedContext}`
    : "You are a helpful assistant for this business.";

  const chatMessages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    ...(history ?? []).reverse().map((m): ChatMessage => ({ role: m.role as ChatMessage["role"], content: m.content })),
    { role: "user", content: message },
  ];

  let reply: string;
  try {
    reply = await deepseekChat(env, chatMessages);
  } catch (err) {
    return new Response(JSON.stringify({ error: "chat completion failed" }), { status: 502 });
  }

  const { data: assistantMessage, error: assistantInsertError } = await service
    .from("messages")
    .insert({
      conversation_id: conversationId,
      tenant_id: tenantId,
      session_id: callerId,
      role: "assistant",
      content: reply,
    })
    .select("id")
    .single();
  if (assistantInsertError || !assistantMessage) {
    return new Response(JSON.stringify({ error: "failed to save reply" }), { status: 500 });
  }

  const resp = new Response(
    JSON.stringify({ conversation_id: conversationId, reply, message_id: assistantMessage.id }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
  return withCorsHeaders(resp, origin!);
}
