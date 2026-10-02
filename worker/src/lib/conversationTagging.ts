import type { SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "./env";
import type { ChatMessage } from "./deepseek";
import { chatWithFallback } from "./chatProvider";

// Per hourly cron tick. Sized well above a busy tenant's realistic conversation
// volume (e.g. ~2000/day is ~85/hour on average) so the backlog doesn't grow
// unbounded, while still being self-healing like compute_widget_daily_stats -- a
// missed or lighter tick just means the next one has more candidates to work through.
const TAG_BATCH_LIMIT = 300;
const TAG_CONCURRENCY = 10;

// Bounds a single conversation's own tagging prompt regardless of how long it ran --
// the first/last messages of even a very long support conversation are normally
// enough to identify what it was about.
const MAX_MESSAGES_PER_CONVERSATION = 40;

const TAGGING_SYSTEM_PROMPT = `You are labeling a customer support conversation for internal analytics. Read the conversation and respond with ONLY a JSON object, no other text, in exactly this shape:
{"topic_label": "a short 2-5 word topic", "summary": "one sentence describing what the customer wanted"}`;

interface TaggingCandidate {
  conversation_id: string;
  tenant_id: string;
  widget_id: string;
  conversation_date: string;
  conversation_started_at: string;
}

interface TaggingResult {
  topic_label: string;
  summary: string;
}

function parseTaggingResponse(raw: string): TaggingResult | null {
  // Models occasionally wrap JSON in a fenced code block despite being told not to
  // -- strip that rather than failing the whole tag over a formatting quirk.
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const topicLabel = (parsed as Record<string, unknown>).topic_label;
  const summary = (parsed as Record<string, unknown>).summary;
  if (typeof topicLabel !== "string" || typeof summary !== "string" || !topicLabel.trim() || !summary.trim()) {
    return null;
  }
  return { topic_label: topicLabel.slice(0, 100), summary: summary.slice(0, 500) };
}

// Tags a single conversation and stores the result, replacing any existing tag for
// it. Used two ways (see callers below): a fast "preliminary" pass (isFinal=false)
// from just the first message, fired off from chat.ts without delaying the chat
// reply, and a "final" pass (isFinal=true) from the hourly cron once the
// conversation has actually gone quiet, reading the full transcript. Delete-then-
// insert rather than upsert -- replacing a preliminary tag with a final one (or a
// stale final one with a fresh one after the conversation resumes and re-quiets)
// this way needs no unique constraint or ON CONFLICT target.
export async function tagOneConversation(env: Env, service: SupabaseClient, candidate: TaggingCandidate, isFinal: boolean): Promise<void> {
  const { data: messages } = await service
    .from("messages")
    .select("role, content")
    .eq("conversation_id", candidate.conversation_id)
    .order("created_at", { ascending: true })
    .limit(MAX_MESSAGES_PER_CONVERSATION);

  // Nothing to tag -- e.g. a conversation row created but never actually messaged.
  if (!messages || messages.length === 0) return;

  const transcript = messages.map((m) => `${m.role}: ${m.content}`).join("\n");
  const chatMessages: ChatMessage[] = [
    { role: "system", content: TAGGING_SYSTEM_PROMPT },
    { role: "user", content: transcript },
  ];

  let raw: string;
  try {
    raw = await chatWithFallback(env, chatMessages, 150); // a small JSON object, no need for much headroom
  } catch {
    return; // best-effort -- stays untagged (or keeps its prior tag), retried later
  }

  const result = parseTaggingResponse(raw);
  if (!result) return;

  await service.from("conversation_topics").delete().eq("conversation_id", candidate.conversation_id);
  await service.from("conversation_topics").insert({
    conversation_id: candidate.conversation_id,
    tenant_id: candidate.tenant_id,
    widget_id: candidate.widget_id,
    conversation_date: candidate.conversation_date,
    conversation_started_at: candidate.conversation_started_at,
    topic_label: result.topic_label,
    summary: result.summary,
    is_final: isFinal,
  });
}

// Called from the hourly cron (see index.ts's scheduled() handler). Each candidate is
// tagged independently -- one conversation failing (a malformed response, both
// providers down for that call) never blocks the rest of the batch, and it simply
// stays untagged (or keeps its preliminary tag) for the next tick to pick up again.
// This is the "final" pass -- see tagOneConversation's own comment.
export async function tagQuietConversations(env: Env, service: SupabaseClient): Promise<void> {
  const { data: candidates } = await service.rpc("find_untagged_quiet_conversations", { p_limit: TAG_BATCH_LIMIT });
  const queue = (candidates ?? []) as TaggingCandidate[];

  for (let i = 0; i < queue.length; i += TAG_CONCURRENCY) {
    const chunk = queue.slice(i, i + TAG_CONCURRENCY);
    await Promise.all(chunk.map((candidate) => tagOneConversation(env, service, candidate, true)));
  }
}
