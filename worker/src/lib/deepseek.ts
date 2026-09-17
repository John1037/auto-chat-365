import type { Env } from "./env";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

// Observed directly: DeepSeek can hang rather than error during an outage (their
// own status page has shown real incidents on the chat service, not just bad luck
// here). Without a timeout, that hang would consume the whole request instead of
// ever reaching the OpenAI fallback in chat.ts -- a fast, clean failure is what
// actually makes that fallback useful.
const CHAT_TIMEOUT_MS = 20_000;

export async function deepseekChat(env: Env, messages: ChatMessage[], maxTokens?: number): Promise<string> {
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

  const json = (await response.json()) as { choices: { message: { content: string } }[] };
  const content = json.choices[0]?.message?.content;
  if (!content) {
    // DeepSeek has returned bare 200s with an empty body during outages (observed
    // directly, independent of model choice) -- treat that the same as a thrown
    // error so callers' fallback logic (see chat.ts) catches it uniformly.
    throw new Error("DeepSeek returned an empty response");
  }
  return content;
}
