import type { Env } from "./env";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatCompletionResult {
  content: string;
  // "length" means the provider cut the reply off to stay within max_tokens --
  // callers use this to detect and recover from truncation (see
  // chatProvider.ts's completeWithCondenseRetry). null if the field was missing
  // from the response for some reason; treated the same as "not truncated."
  finishReason: string | null;
}

// Observed directly: DeepSeek can hang rather than error during an outage (their
// own status page has shown real incidents on the chat service, not just bad luck
// here). Without a timeout, that hang would consume the whole request instead of
// ever reaching the OpenAI fallback in chat.ts -- a fast, clean failure is what
// actually makes that fallback useful.
const CHAT_TIMEOUT_MS = 20_000;

export async function deepseekChat(env: Env, messages: ChatMessage[], maxTokens?: number): Promise<ChatCompletionResult> {
  const response = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: "deepseek-flash", messages, ...(maxTokens ? { max_tokens: maxTokens } : {}) }),
    signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`DeepSeek chat request failed: ${response.status} ${await response.text()}`);
  }

  const json = (await response.json()) as { choices: { message: { content: string }; finish_reason?: string }[] };
  const choice = json.choices[0];
  const content = choice?.message?.content;
  if (!content) {
    // A small max_tokens budget can leave a model zero room to emit any visible
    // content at all (e.g. a reasoning-style model that spends its whole budget on
    // hidden reasoning tokens first) -- that's still a length-truncation, just an
    // extreme one, and completeWithCondenseRetry's retry (with real extra headroom)
    // is exactly the right response to it, not a hard failure. Only treat this as a
    // genuine error when the empty body ISN'T explained by running out of budget --
    // DeepSeek has returned bare 200s with an empty body during real outages
    // (observed directly, independent of model choice).
    if (choice?.finish_reason === "length") {
      return { content: "", finishReason: "length" };
    }
    throw new Error("DeepSeek returned an empty response");
  }
  return { content, finishReason: choice?.finish_reason ?? null };
}
