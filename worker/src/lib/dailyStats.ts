import type { SupabaseClient } from "@supabase/supabase-js";

export interface ChatStatEvent {
  retrievalUsed: boolean;
  fallbackUsed: boolean;
  rateLimited: boolean;
  guardrailInjection: boolean;
  guardrailBlockedTopic: boolean;
  guardrailProfanity: boolean;
  guardrailNsfw: boolean;
  guardrailModeration: boolean;
  latencyMs?: number;
}

// conversations_started/messages_count are NOT recorded here -- those are computed
// later, in one deferred batch (see migration 0025's compute_widget_daily_stats),
// by aggregating the real conversations/messages tables once a day has closed. This
// function is only for the counters that leave no other trace: a guardrail-refused
// reply is stored as an ordinary-looking assistant message, indistinguishable after
// the fact from a normal one, so those facts have to be captured right now, at the
// moment each one is actually known.
//
// Best-effort and non-fatal by design -- called from chat.ts wrapped so a stats
// hiccup never breaks the actual reply a visitor is waiting on. Never awaited by a
// caller that then throws on failure; swallow the error here so every call site
// gets that for free rather than needing its own try/catch.
export async function recordChatStats(service: SupabaseClient, widgetId: string, tenantId: string, event: ChatStatEvent): Promise<void> {
  try {
    await service.rpc("increment_widget_daily_stats", {
      p_widget_id: widgetId,
      p_tenant_id: tenantId,
      p_retrieval_used: event.retrievalUsed,
      p_fallback_used: event.fallbackUsed,
      p_rate_limited: event.rateLimited,
      p_guardrail_injection: event.guardrailInjection,
      p_guardrail_blocked_topic: event.guardrailBlockedTopic,
      p_guardrail_profanity: event.guardrailProfanity,
      p_guardrail_nsfw: event.guardrailNsfw,
      p_guardrail_moderation: event.guardrailModeration,
      p_latency_ms: event.latencyMs ?? null,
    });
  } catch {
    // Best-effort -- never let a stats-recording failure affect the chat turn.
  }
}
