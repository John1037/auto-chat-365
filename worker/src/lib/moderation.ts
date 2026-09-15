import type { Env } from "./env";

const MODERATION_TIMEOUT_MS = 8_000; // this gates every message -- fail open (see below) rather than let a slow moderation call stall the whole chat turn

// Categories treated as an unconditional platform floor: universally prohibited or
// severe-harm content, per the guardrail split (a tenant cannot configure these
// away -- see migration 0018's comment). Deliberately narrower than the full
// category list: general/mild sexual, hate, harassment, or violence content is real
// but not always-refuse-worthy for an ecommerce support bot, so those are left for a
// future tenant-configurable "content strictness" dial rather than hard-blocked here.
const HARD_BLOCK_CATEGORIES = new Set([
  "sexual/minors",
  "self-harm/instructions",
  "self-harm/intent",
  "hate/threatening",
  "harassment/threatening",
  "violence/graphic",
  "illicit/violent",
]);

export interface ModerationResult {
  hardBlocked: boolean;
  categories: string[];
}

interface ModerationApiResponse {
  results: { flagged: boolean; categories: Record<string, boolean> }[];
}

// Checked on both the visitor's message (before it reaches the chat model) and the
// model's own reply (before it reaches the visitor) -- defense in depth, since a
// model can produce unsafe content even from an innocuous prompt. Fails OPEN (never
// blocks) on any network/API error: moderation is a safety net on top of the chat
// model, not the thing standing between a visitor and a working widget, so an
// OpenAI outage shouldn't take chat down platform-wide alongside it.
export async function checkModeration(env: Env, text: string): Promise<ModerationResult> {
  try {
    const response = await fetch("https://api.openai.com/v1/moderations", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ input: text }),
      signal: AbortSignal.timeout(MODERATION_TIMEOUT_MS),
    });
    if (!response.ok) return { hardBlocked: false, categories: [] };

    const json = (await response.json()) as ModerationApiResponse;
    const result = json.results[0];
    if (!result?.flagged) return { hardBlocked: false, categories: [] };

    const flaggedCategories = Object.entries(result.categories)
      .filter(([, flagged]) => flagged)
      .map(([category]) => category);
    const hardBlocked = flaggedCategories.some((category) => HARD_BLOCK_CATEGORIES.has(category));
    return { hardBlocked, categories: flaggedCategories };
  } catch {
    return { hardBlocked: false, categories: [] };
  }
}
