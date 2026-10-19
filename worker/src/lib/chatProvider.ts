import type { SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "./env";
import { deepseekChat, type ChatMessage, type ChatCompletionResult } from "./deepseek";
import { openaiChat } from "./openai";

export interface ChatReplyResult {
  reply: string;
  usedFallback: boolean;
}

// Absolute last resort: a fixed, complete, zero-cost message for the degenerate case
// where even the widened condense-retry comes back with nothing usable (confirmed
// reachable directly: a demanding enough question against a small enough budget can
// still leave a reasoning-style model no room for visible output on both attempts).
// Never returned instead of a real answer -- only when there categorically isn't one
// to give within budget.
const FALLBACK_REPLY = "That's a lot to cover in one answer -- could you narrow your question down a bit?";

// Last-resort guarantee, applied to every completion regardless of how it was
// produced: never return text that stops mid-clause. Normally a no-op (a reply that
// finished naturally already ends on real punctuation), and after
// completeWithCondenseRetry below it should be rare to even reach a case where this
// has to cut anything -- but it's the one thing standing between a provider hiccup
// and a visibly broken reply, so it always runs.
function trimToCompleteSentence(text: string): string {
  const trimmed = text.trimEnd();
  if (/[.!?]['"”)]?$/.test(trimmed)) return trimmed;

  const lastEnd = Math.max(
    trimmed.lastIndexOf(". "),
    trimmed.lastIndexOf("! "),
    trimmed.lastIndexOf("? "),
    trimmed.lastIndexOf(".\n"),
    trimmed.lastIndexOf("!\n"),
    trimmed.lastIndexOf("?\n"),
  );
  if (lastEnd === -1) return trimmed; // no clean boundary anywhere -- nothing better to return
  const cut = trimmed.slice(0, lastEnd + 1);
  return cut.length >= 10 ? cut : trimmed; // don't collapse to a near-empty reply
}

// The actual fix for a reply getting cut off mid-sentence: raising max_tokens only
// moves the threshold, it doesn't guarantee completeness for an answer that's
// genuinely longer than the budget on its first attempt. This detects that via the
// completion API's own finish_reason ("length" = the provider truncated it to stay
// under max_tokens) and asks the model to answer again, from scratch, as a complete
// response that fits -- passing the cut-off first attempt as context so it can judge
// where it ran long.
//
// The retry gets real extra headroom, not the same tight budget that already didn't
// fit -- confirmed directly against the real API that asking a model to continue
// reasoning about an already-long exchange within the SAME small budget that just
// failed can return a hard 400 ("could not finish the message because max_tokens...
// was reached") instead of a second soft truncation. Retrying with an unchanged
// budget and hoping for a different outcome doesn't make sense; this is a rare path
// (only reached once per turn, at most), so the extra cost is worth guaranteeing
// completeness over.
//
// If the retry itself throws (including that 400), fall back to the trimmed first
// attempt rather than letting the error reach the visitor -- a complete reply drawn
// from a cut-off source still beats a hard failure. trimToCompleteSentence is the
// final safety net either way, in case even the retry still runs long.
async function completeWithCondenseRetry(
  callModel: (messages: ChatMessage[], maxTokens?: number) => Promise<ChatCompletionResult>,
  messages: ChatMessage[],
  maxTokens?: number,
): Promise<string> {
  const first = await callModel(messages, maxTokens);
  if (first.finishReason !== "length") return trimToCompleteSentence(first.content) || FALLBACK_REPLY;

  const retryMessages: ChatMessage[] = [
    ...messages,
    { role: "assistant", content: first.content },
    {
      role: "user",
      content:
        "That got cut off before you finished. Answer again from the start as a complete, self-contained response that fits entirely within the length limit -- it's fine to cover less detail, but the response must not be cut off mid-sentence.",
    },
  ];
  const retryMaxTokens = maxTokens ? Math.max(maxTokens * 3, 300) : undefined;
  try {
    const second = await callModel(retryMessages, retryMaxTokens);
    return trimToCompleteSentence(second.content) || trimToCompleteSentence(first.content) || FALLBACK_REPLY;
  } catch {
    return trimToCompleteSentence(first.content) || FALLBACK_REPLY;
  }
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
  maxTokens?: number,
): Promise<ChatReplyResult> {
  if (!useFallback) {
    try {
      const reply = await completeWithCondenseRetry((msgs, mt) => deepseekChat(env, msgs, mt), messages, maxTokens);
      return { reply, usedFallback: false };
    } catch {
      await service.from("widget_sessions").update({ use_fallback_chat: true }).eq("id", sessionId);
    }
  }
  const reply = await completeWithCondenseRetry((msgs, mt) => openaiChat(env, msgs, mt), messages, maxTokens);
  return { reply, usedFallback: true };
}

// A simpler fallback than getChatReply above -- no per-session persisted "always use
// fallback from now on" state, since callers here (conversation tagging, AI Analysis)
// aren't a single visitor's ongoing session. A transient DeepSeek failure on one call
// just falls back to OpenAI for that one call.
export async function chatWithFallback(env: Env, messages: ChatMessage[], maxTokens?: number): Promise<string> {
  try {
    return await completeWithCondenseRetry((msgs, mt) => deepseekChat(env, msgs, mt), messages, maxTokens);
  } catch {
    return await completeWithCondenseRetry((msgs, mt) => openaiChat(env, msgs, mt), messages, maxTokens);
  }
}
