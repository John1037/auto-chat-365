import type { Env } from "../lib/env";
import { getServiceClient, getVerifiedUser, getBearerToken } from "../lib/supabase";
import { getOwnerTenantId } from "../lib/tenantOwner";
import { verifyOwnedWidgetIds } from "../lib/widgetVisibility";
import { checkRateLimit } from "../lib/rateLimit";
import { chatWithFallback } from "../lib/chatProvider";
import type { ChatMessage } from "../lib/deepseek";

interface AnalysisBody {
  query?: string;
  range_start?: string;
  range_end?: string;
  widget_id?: string;
}

const MAX_QUERY_LENGTH = 500;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// A real LLM call per question, unlike Volume (which is pure Postgres via RLS) --
// worth its own tenant-wide limit independent of the chat widget's own per-widget
// rate limits.
const ANALYSIS_RATE_WINDOW_SECONDS = 3600;
const ANALYSIS_RATE_LIMIT = 20;

// However many distinct topics a query's date range/widget scope actually contains,
// only the busiest MAX_TOPICS get sent to the LLM, each with at most
// MAX_SAMPLES_PER_TOPIC example summaries. This is what actually bounds the prompt
// size regardless of how many conversations happened -- a busy day collapses into
// however many distinct topics customers raised (typically dozens), not one row per
// conversation. See conversationTagging.ts for how conversation_topics gets
// populated in the first place.
const MAX_TOPICS = 40;
const MAX_SAMPLES_PER_TOPIC = 3;

const ANALYSIS_SYSTEM_PROMPT = `You are analyzing aggregated customer-conversation topic data for a business's internal dashboard. You are given a list of topics customers' conversations covered during a selected period, each with how many conversations covered it and a few example one-line summaries. Answer the user's question using only this data. If the data doesn't contain enough information to fully answer the question, say so plainly rather than guessing or inventing detail. Write a concise, plain-prose answer, not a bulleted restatement of the data.`;

export async function handleAiAnalysis(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const jwt = getBearerToken(request);
  const user = await getVerifiedUser(env, jwt);
  if (!user || user.isAnonymous) {
    return new Response(JSON.stringify({ error: "invalid or expired session" }), { status: 401 });
  }

  const tenantId = await getOwnerTenantId(env, user.id);
  if (!tenantId) {
    return new Response(JSON.stringify({ error: "no tenant found for this account" }), { status: 403 });
  }

  const service = getServiceClient(env);

  const withinLimit = await checkRateLimit(service, tenantId, "tenant", `ai-analysis:${tenantId}`, ANALYSIS_RATE_WINDOW_SECONDS, ANALYSIS_RATE_LIMIT);
  if (!withinLimit) {
    return new Response(JSON.stringify({ error: "You've reached the analysis query limit for this hour. Try again shortly." }), { status: 429 });
  }

  let body: AnalysisBody;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid JSON body" }), { status: 400 });
  }

  const query = body.query?.trim();
  if (!query) {
    return new Response(JSON.stringify({ error: "query is required" }), { status: 400 });
  }
  if (query.length > MAX_QUERY_LENGTH) {
    return new Response(JSON.stringify({ error: `query is too long (${MAX_QUERY_LENGTH} characters max)` }), { status: 400 });
  }

  const rangeStart = body.range_start;
  const rangeEnd = body.range_end;
  if (!rangeStart || !rangeEnd || !ISO_DATE_RE.test(rangeStart) || !ISO_DATE_RE.test(rangeEnd) || rangeStart > rangeEnd) {
    return new Response(JSON.stringify({ error: "range_start and range_end must be valid dates, with range_start on or before range_end" }), { status: 400 });
  }

  let widgetId: string | null = null;
  if (body.widget_id && body.widget_id !== "all") {
    const owned = await verifyOwnedWidgetIds(service, tenantId, [body.widget_id]);
    if (owned.length === 0) {
      return new Response(JSON.stringify({ error: "widget not found for this account" }), { status: 403 });
    }
    widgetId = owned[0];
  }

  let topicsQuery = service
    .from("conversation_topics")
    .select("topic_label, summary")
    .eq("tenant_id", tenantId)
    .gte("conversation_date", rangeStart)
    .lte("conversation_date", rangeEnd);
  if (widgetId) topicsQuery = topicsQuery.eq("widget_id", widgetId);

  const { data: rows, error: rowsError } = await topicsQuery;
  if (rowsError) {
    return new Response(JSON.stringify({ error: "failed to load conversation topics" }), { status: 500 });
  }

  if (!rows || rows.length === 0) {
    return new Response(
      JSON.stringify({
        answer: "There's no tagged conversation data for this range yet. Conversations are tagged shortly after they go quiet, so very recent activity may not have been processed yet.",
        conversations_considered: 0,
        topics_considered: 0,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }

  const groups = new Map<string, { count: number; samples: string[] }>();
  for (const row of rows as { topic_label: string; summary: string }[]) {
    const group = groups.get(row.topic_label) ?? { count: 0, samples: [] };
    group.count += 1;
    if (group.samples.length < MAX_SAMPLES_PER_TOPIC) group.samples.push(row.summary);
    groups.set(row.topic_label, group);
  }

  const sortedGroups = Array.from(groups.entries()).sort((a, b) => b[1].count - a[1].count);
  const truncated = sortedGroups.length > MAX_TOPICS;
  const topGroups = sortedGroups.slice(0, MAX_TOPICS);

  const topicLines = topGroups
    .map(([label, group]) => `- ${label} (${group.count} conversation${group.count === 1 ? "" : "s"}): ${group.samples.join(" | ")}`)
    .join("\n");

  const userPrompt = [
    `Period: ${rangeStart} to ${rangeEnd}`,
    `Total tagged conversations in this period: ${rows.length}`,
    truncated ? `Showing only the ${MAX_TOPICS} most common topics out of ${sortedGroups.length} distinct topics.` : "",
    "",
    "Topics:",
    topicLines,
    "",
    `Question: ${query}`,
  ]
    .filter(Boolean)
    .join("\n");

  const chatMessages: ChatMessage[] = [
    { role: "system", content: ANALYSIS_SYSTEM_PROMPT },
    { role: "user", content: userPrompt },
  ];

  let answer: string;
  try {
    answer = await chatWithFallback(env, chatMessages, 600);
  } catch {
    return new Response(JSON.stringify({ error: "analysis failed -- try again shortly" }), { status: 502 });
  }

  return new Response(
    JSON.stringify({ answer, conversations_considered: rows.length, topics_considered: sortedGroups.length }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}
