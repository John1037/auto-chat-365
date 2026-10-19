import type { Env } from "./env";
import type { ChatMessage, ChatCompletionResult } from "./deepseek";

const EMBEDDING_MODEL = "text-embedding-3-small"; // 1536 dims, matches
// tenant_document_chunks.embedding vector(1536) in
// supabase/migrations/0002_documents_and_vectors.sql.

// Cost-optimized tier, not the flagship -- this only ever runs as a fallback when
// DeepSeek itself has failed, so it should be cheap and fast, not necessarily the
// most capable thing OpenAI offers. Confirmed against the real API (as of this
// writing DeepSeek's own status page shows real incidents on their chat service,
// not just this project's bad luck) -- max_tokens isn't accepted by this model,
// use max_completion_tokens if a cap is ever needed.
const FALLBACK_CHAT_MODEL = "gpt-5.6-luna";
const CHAT_TIMEOUT_MS = 20_000; // this is the fallback of last resort -- fail fast rather than leave the visitor waiting indefinitely

export async function embedText(env: Env, text: string): Promise<number[]> {
  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: text }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI embeddings request failed: ${response.status} ${await response.text()}`);
  }

  const json = (await response.json()) as { data: { embedding: number[] }[] };
  return json.data[0].embedding;
}

export async function embedTexts(env: Env, texts: string[]): Promise<number[][]> {
  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: texts }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI embeddings request failed: ${response.status} ${await response.text()}`);
  }

  const json = (await response.json()) as { data: { embedding: number[]; index: number }[] };
  return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

// Fallback for handleChat when DeepSeek fails or returns an empty response (see
// chat.ts) -- same OpenAI key already used for embeddings, just a different
// endpoint. Same ChatMessage shape as deepseekChat so the caller doesn't need to
// know which provider actually served a given request.
export async function openaiChat(env: Env, messages: ChatMessage[], maxTokens?: number): Promise<ChatCompletionResult> {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    // This model takes max_completion_tokens, not max_tokens -- confirmed directly
    // against the real API (see FALLBACK_CHAT_MODEL's own comment above).
    body: JSON.stringify({ model: FALLBACK_CHAT_MODEL, messages, ...(maxTokens ? { max_completion_tokens: maxTokens } : {}) }),
    signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`OpenAI chat request failed: ${response.status} ${await response.text()}`);
  }

  const json = (await response.json()) as { choices: { message: { content: string }; finish_reason?: string }[] };
  const choice = json.choices[0];
  const content = choice?.message?.content;
  if (!content) {
    // A small max_tokens budget can leave this model zero room to emit any visible
    // content at all (confirmed directly against the real API -- this model uses
    // reasoning tokens that count against max_completion_tokens before any visible
    // output does). That's still a length-truncation, just an extreme one, and
    // completeWithCondenseRetry's retry (with real extra headroom) is the right
    // response to it, not a hard failure.
    if (choice?.finish_reason === "length") {
      return { content: "", finishReason: "length" };
    }
    throw new Error("OpenAI returned an empty response");
  }
  return { content, finishReason: choice?.finish_reason ?? null };
}
