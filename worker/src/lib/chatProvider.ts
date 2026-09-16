import type { SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "./env";
import { deepseekChat, type ChatMessage } from "./deepseek";
import { openaiChat } from "./openai";

export interface ChatReplyResult {
  reply: string;
  usedFallback: boolean;
}

// Tries DeepSeek first (unless this visitor session has already been marked as
// using the fallback), falling back to OpenAI on any failure. Once DeepSeek fails
// for a session, that's persisted on widget_sessions so every later message in the
// same session skips straight to OpenAI -- otherwise each message would pay
// DeepSeek's own timeout again for a provider already known to be down right now.
// Lets openaiChat's own error propagate to the caller if it also fails.
//
// Reports usedFallback so callers (specifically, the daily-stats tracking in
// chat.ts) know which provider actually served this specific reply -- a session
// already flagged as fallback, and a session that JUST failed over on this exact
// turn, both count, since either way this reply didn't come from DeepSeek.
export async function getChatReply(
  env: Env,
  service: SupabaseClient,
  sessionId: string,
  useFallback: boolean,
  messages: ChatMessage[],
): Promise<ChatReplyResult> {
  if (!useFallback) {
    try {
      return { reply: await deepseekChat(env, messages), usedFallback: false };
    } catch {
      await service.from("widget_sessions").update({ use_fallback_chat: true }).eq("id", sessionId);
    }
  }
  return { reply: await openaiChat(env, messages), usedFallback: true };
}
