import type { Env } from "../lib/env";
import { getServiceClient, getVerifiedUserId, getBearerToken } from "../lib/supabase";
import { isOriginAllowed } from "../lib/cors";
import { checkRateLimit } from "../lib/rateLimit";
import { embedText } from "../lib/openai";
import type { ChatMessage } from "../lib/deepseek";
import { getChatReply } from "../lib/chatProvider";
import { buildSystemPrompt } from "../lib/systemPrompt";
import {
  MAX_MESSAGE_LENGTH,
  redactSensitiveInfo,
  detectPromptInjectionAttempt,
  containsProfanity,
  matchesBlockedTopic,
  detectHardBlockedNsfwContent,
} from "../lib/guardrails";
import { checkModeration } from "../lib/moderation";
import { recordChatStats } from "../lib/dailyStats";

// Generic on purpose -- naming which specific check fired (injection attempt,
// blocked topic, profanity, moderation category) to the visitor would just hand an
// attacker a signal for which guardrail to probe around next.
const GUARDRAIL_REFUSAL_MESSAGE = "I'm not able to help with that request. Is there something else I can help you with?";

interface ChatBody {
  message?: string;
  conversation_id?: string;
}

const RETRIEVAL_LIMIT = 5;
const HISTORY_LIMIT = 10;
const SESSION_RATE_WINDOW_SECONDS = 60;
const SESSION_RATE_LIMIT = 20;
const DAILY_RATE_WINDOW_SECONDS = 86400;

// The chat round trip: verify the visitor, re-derive their tenant/widget from our own
// records (never from the JWT claim alone), retrieve tenant+widget-scoped context,
// call the LLM, and persist both sides of the exchange.
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

  // Defense in depth beyond RLS: derive tenant_id/widget_id from our own
  // widget_sessions row, not from the JWT's tenant_id claim, in case the Custom
  // Access Token Hook ever has a bug or the session has since been revoked.
  const { data: session, error: sessionError } = await service
    .from("widget_sessions")
    .select("tenant_id, widget_id, revoked, use_fallback_chat")
    .eq("id", callerId)
    .maybeSingle();

  if (sessionError || !session || session.revoked) {
    return new Response(JSON.stringify({ error: "session not found or revoked" }), { status: 401 });
  }

  const tenantId = session.tenant_id as string;
  const widgetId = session.widget_id as string;

  const { data: widget, error: widgetError } = await service
    .from("widgets")
    .select(
      "allowed_origins, rate_limit_per_minute, rate_limit_daily, character_style, response_style, response_length, profanity_policy, off_topic_policy, blocked_topics, nsfw_policy, tenants!inner(is_active)",
    )
    .eq("id", widgetId)
    .maybeSingle();

  const tenant = widget?.tenants as unknown as { is_active: boolean } | undefined;
  if (widgetError || !widget || !tenant?.is_active) {
    return new Response(JSON.stringify({ error: "widget not found or tenant inactive" }), { status: 404 });
  }

  if (!isOriginAllowed(origin, widget.allowed_origins)) {
    return new Response(JSON.stringify({ error: "origin not allowed for this widget" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }

  const [withinSessionLimit, withinTenantLimit, withinDailyLimit] = await Promise.all([
    checkRateLimit(service, tenantId, "session", callerId, SESSION_RATE_WINDOW_SECONDS, SESSION_RATE_LIMIT),
    checkRateLimit(service, tenantId, "tenant", `chat:${widgetId}`, 60, widget.rate_limit_per_minute),
    checkRateLimit(service, tenantId, "tenant", `chat-daily:${widgetId}`, DAILY_RATE_WINDOW_SECONDS, widget.rate_limit_daily),
  ]);
  if (!withinSessionLimit || !withinTenantLimit || !withinDailyLimit) {
    await recordChatStats(service, widgetId, tenantId, {
      retrievalUsed: false,
      fallbackUsed: false,
      rateLimited: true,
      guardrailInjection: false,
      guardrailBlockedTopic: false,
      guardrailProfanity: false,
      guardrailNsfw: false,
      guardrailModeration: false,
    });
    return new Response(JSON.stringify({ error: "rate limit exceeded" }), {
      status: 429,
      headers: { "Content-Type": "application/json" },
    });
  }

  let body: ChatBody;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid JSON body" }), { status: 400 });
  }
  const rawMessage = body.message?.trim();
  if (!rawMessage) {
    return new Response(JSON.stringify({ error: "message is required" }), { status: 400 });
  }
  if (rawMessage.length > MAX_MESSAGE_LENGTH) {
    return new Response(JSON.stringify({ error: `message is too long (${MAX_MESSAGE_LENGTH} characters max)` }), { status: 400 });
  }

  // Platform floor, not tenant-configurable: a pasted card number or API key/token
  // should never land in our own storage or be forwarded to an LLM provider. This is
  // what gets stored and sent onward from here on -- the visitor's own browser still
  // shows what they actually typed (that's rendered client-side from their own input,
  // never from this response).
  const message = redactSensitiveInfo(rawMessage);

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
    if (convError) {
      return new Response(JSON.stringify({ error: "failed to look up conversation" }), { status: 500 });
    }
    // A client-supplied conversation_id that doesn't resolve is a stale-state mismatch,
    // not the visitor's fault -- most commonly a conversation_id left over from a since-
    // replaced session_id (every /api/session-start mints a brand-new anonymous session,
    // so a widget carrying an old conversation_id forward across that boundary is exactly
    // this case). Silently start a new conversation instead of failing the chat turn.
    if (!existing) {
      conversationId = undefined;
    }
  }
  if (!conversationId) {
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

  // A conversation resuming after already being tagged (see conversationTagging.ts)
  // means its topic tag is now stale -- clear it so the hourly job re-tags it once it
  // goes quiet again. Harmless no-op on the far more common case of an untagged or
  // brand-new conversation; never worth failing the chat turn over.
  await service.from("conversation_topics").delete().eq("conversation_id", conversationId);

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

  // Guardrail checks -- all deterministic and all before the model is ever called
  // ("never trust the model with access control" extends to safety, not just data
  // access). Ordered platform floor first, then the tenant's own configurable dials.
  // A hit here skips retrieval and the LLM entirely and returns a fixed refusal as a
  // normal 200 reply (not an error), so it displays and is stored like any other
  // assistant turn -- the visitor sees a graceful decline, not a broken widget.
  const inputModeration = await checkModeration(env, message);
  const blockedTopic = matchesBlockedTopic(message, widget.blocked_topics ?? []);
  const injectionDetected = detectPromptInjectionAttempt(message);
  const hardBlockedNsfw = detectHardBlockedNsfwContent(message);
  const profanityRefused = widget.profanity_policy === "refuse" && containsProfanity(message);
  // General NSFW content is gated by the tenant's own nsfw_policy (moderation's
  // "sexual" category), but sexual violence, non-consent, incest, and minors are not
  // -- detectHardBlockedNsfwContent and moderation's own sexual/minors category
  // (folded into inputModeration.hardBlocked) apply no matter what nsfw_policy is set
  // to, since that one coarse "sexual" score can't tell those apart on its own
  // (verified directly against the real API -- see guardrails.ts).
  const nsfwRefused = hardBlockedNsfw || (widget.nsfw_policy === "refuse" && inputModeration.categories.includes("sexual"));
  const isGuardrailBlocked =
    inputModeration.hardBlocked || injectionDetected || nsfwRefused || blockedTopic !== null || profanityRefused;

  if (isGuardrailBlocked) {
    await recordChatStats(service, widgetId, tenantId, {
      retrievalUsed: false,
      fallbackUsed: false,
      rateLimited: false,
      guardrailInjection: injectionDetected,
      guardrailBlockedTopic: blockedTopic !== null,
      guardrailProfanity: profanityRefused,
      guardrailNsfw: nsfwRefused,
      guardrailModeration: inputModeration.hardBlocked,
    });
    const { data: refusalMessage, error: refusalInsertError } = await service
      .from("messages")
      .insert({ conversation_id: conversationId, tenant_id: tenantId, session_id: callerId, role: "assistant", content: GUARDRAIL_REFUSAL_MESSAGE })
      .select("id")
      .single();
    if (refusalInsertError || !refusalMessage) {
      return new Response(JSON.stringify({ error: "failed to save reply" }), { status: 500 });
    }
    return new Response(
      JSON.stringify({ conversation_id: conversationId, reply: GUARDRAIL_REFUSAL_MESSAGE, message_id: refusalMessage.id }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }

  // Retrieval is widget-aware: a chunk is visible if its document is global, or
  // explicitly linked to this widget via widget_documents (see migration 0008).
  let retrievedContext = "";
  try {
    const queryEmbedding = await embedText(env, message);
    const { data: chunks } = await service.rpc("match_tenant_document_chunks", {
      p_tenant_id: tenantId,
      p_widget_id: widgetId,
      p_query_embedding: queryEmbedding,
      p_match_count: RETRIEVAL_LIMIT,
    });
    if (chunks?.length) {
      retrievedContext = chunks.map((c: { content: string }) => c.content).join("\n---\n");
    }
  } catch {
    // Never fail the chat turn because retrieval had a problem -- best-effort.
  }

  const systemPrompt = buildSystemPrompt(
    {
      characterStyle: widget.character_style,
      responseStyle: widget.response_style,
      responseLength: widget.response_length,
    },
    retrievedContext,
    {
      profanityPolicy: widget.profanity_policy,
      offTopicPolicy: widget.off_topic_policy,
      nsfwPolicy: widget.nsfw_policy,
    },
  );

  const chatMessages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    ...(history ?? []).reverse().map((m): ChatMessage => ({ role: m.role as ChatMessage["role"], content: m.content })),
    { role: "user", content: message },
  ];

  // DeepSeek has had real incidents (their own status page, not just this
  // project) -- fall back to OpenAI rather than failing the whole chat turn. Once
  // it's failed once for this session, use_fallback_chat skips straight to OpenAI
  // on every later message instead of paying DeepSeek's own timeout again.
  let reply: string;
  let usedFallback: boolean;
  const chatStartedAt = Date.now();
  try {
    const result = await getChatReply(env, service, callerId, session.use_fallback_chat === true, chatMessages);
    reply = result.reply;
    usedFallback = result.usedFallback;
  } catch {
    return new Response(JSON.stringify({ error: "chat completion failed" }), { status: 502 });
  }
  const latencyMs = Date.now() - chatStartedAt;

  // Defense in depth: the model can produce unsafe content even from an innocuous
  // prompt (retrieved context it was told to treat as untrusted, but which some
  // model somewhere might not fully honor). Checked the same way as the visitor's
  // own input, against the same non-configurable hard-block categories and the same
  // nsfw_policy gate on general sexual content.
  const outputModeration = await checkModeration(env, reply);
  if (
    outputModeration.hardBlocked ||
    detectHardBlockedNsfwContent(reply) ||
    (widget.nsfw_policy === "refuse" && outputModeration.categories.includes("sexual"))
  ) {
    reply = GUARDRAIL_REFUSAL_MESSAGE;
  }

  await recordChatStats(service, widgetId, tenantId, {
    retrievalUsed: retrievedContext !== "",
    fallbackUsed: usedFallback,
    rateLimited: false,
    guardrailInjection: false,
    guardrailBlockedTopic: false,
    guardrailProfanity: false,
    guardrailNsfw: false,
    guardrailModeration: false,
    latencyMs,
  });

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

  return new Response(
    JSON.stringify({ conversation_id: conversationId, reply, message_id: assistantMessage.id }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}
