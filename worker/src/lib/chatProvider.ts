import type { SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "./env";
import { deepseekChat, type ChatMessage } from "./deepseek";
import { openaiChat } from "./openai";

// Tries DeepSeek first (unless this visitor session has already been marked as
// using the fallback), falling back to OpenAI on any failure. Once DeepSeek fails
// for a session, that's persisted on widget_sessions so every later message in the
// same session skips straight to OpenAI -- otherwise each message would pay
// DeepSeek's own timeout again for a provider already known to be down right now.
// Lets openaiChat's own error propagate to the caller if it also fails.
export async function getChatReply(
  env: Env,
  service: SupabaseClient,
  sessionId: string,
  useFallback: boolean,
  messages: ChatMessage[],
): Promise<string> {
  if (!useFallback) {
    try {
      return await deepseekChat(env, messages);
    } catch {
      await service.from("widget_sessions").update({ use_fallback_chat: true }).eq("id", sessionId);
    }
  }
  return openaiChat(env, messages);
}
