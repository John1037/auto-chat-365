-- One row per (widget, local calendar day). A conversation counts toward the day it
-- STARTED in the widget's own timezone, and every message belonging to it counts
-- toward that same day too, even if the conversation runs past local midnight -- a
-- conversation that began at 23:59 local time is not split across two days.
--
-- Two different write paths populate this table, because the two kinds of counters
-- have fundamentally different sources of truth:
--   - conversations_started/messages_count are computed later, in one deferred batch
--     (see migration 0025's compute_widget_daily_stats), by aggregating the real
--     conversations/messages rows once a day has fully closed. That's the actual
--     source of truth for these two, and recomputing from it is always correct and
--     idempotent.
--   - Everything else here (guardrail outcomes, retrieval/fallback/rate-limit usage,
--     latency) leaves no trace anywhere else once the chat turn completes -- a
--     guardrail-refused reply is stored as an ordinary-looking assistant message,
--     indistinguishable after the fact from a normal one. Those must be incremented
--     in real time, from chat.ts, at the moment each fact is actually known.
-- Both paths upsert into the same row (see increment_widget_daily_stats below and
-- migration 0025), keyed by (widget_id, stat_date), so it doesn't matter which one
-- creates the row first.
--
-- Deliberately survives conversation/message retention (migration 0026's
-- purge_expired_conversations never touches this table) -- anonymized, aggregate
-- counts are exactly what a tenant should still be able to see after the underlying
-- transcripts have aged out. It's still deleted in full on account deletion (see
-- migration 0027), since that promise is "everything, unrecoverably", not "everything
-- except analytics".
create table widget_daily_stats (
  widget_id uuid not null references widgets(id) on delete cascade,
  tenant_id uuid not null references tenants(id) on delete cascade,
  stat_date date not null,

  conversations_started int not null default 0,
  messages_count int not null default 0,

  -- Room to grow into, per the guardrails-review discussion: tool/skill-calling
  -- doesn't exist yet, but the column shape is here so that feature doesn't need a
  -- separate stats table bolted on later.
  tool_calls_count int not null default 0,
  skill_uses_count int not null default 0,

  retrieval_used_count int not null default 0,
  fallback_chat_count int not null default 0,
  rate_limit_hit_count int not null default 0,

  guardrail_refusals_count int not null default 0,
  guardrail_injection_count int not null default 0,
  guardrail_blocked_topic_count int not null default 0,
  guardrail_profanity_count int not null default 0,
  guardrail_nsfw_count int not null default 0,
  guardrail_moderation_count int not null default 0,

  -- Stored as sum+count, not a running average -- averaging a sequence of averages
  -- is mathematically wrong; the real average is sum/count, computed at read time.
  latency_sum_ms bigint not null default 0,
  latency_sample_count int not null default 0,

  computed_at timestamptz not null default now(),
  primary key (widget_id, stat_date)
);

create index widget_daily_stats_tenant_id_idx on widget_daily_stats (tenant_id);

-- Called from chat.ts for every chat turn (fire-and-forget from the route's point of
-- view -- wrapped in try/catch there so a stats hiccup never breaks the actual
-- reply). Resolves "today" from the widget's OWN timezone internally, so callers
-- never need to compute or pass a date themselves.
create function increment_widget_daily_stats(
  p_widget_id uuid,
  p_tenant_id uuid,
  p_retrieval_used boolean default false,
  p_fallback_used boolean default false,
  p_rate_limited boolean default false,
  p_guardrail_injection boolean default false,
  p_guardrail_blocked_topic boolean default false,
  p_guardrail_profanity boolean default false,
  p_guardrail_nsfw boolean default false,
  p_guardrail_moderation boolean default false,
  p_latency_ms int default null
) returns void
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_tz text;
  v_local_date date;
  v_refused boolean;
begin
  select timezone into v_tz from widgets where id = p_widget_id;
  v_local_date := (now() at time zone coalesce(v_tz, 'UTC'))::date;
  v_refused := p_guardrail_injection or p_guardrail_blocked_topic or p_guardrail_profanity or p_guardrail_nsfw or p_guardrail_moderation;

  insert into widget_daily_stats (
    widget_id, tenant_id, stat_date,
    retrieval_used_count, fallback_chat_count, rate_limit_hit_count,
    guardrail_refusals_count, guardrail_injection_count, guardrail_blocked_topic_count,
    guardrail_profanity_count, guardrail_nsfw_count, guardrail_moderation_count,
    latency_sum_ms, latency_sample_count
  ) values (
    p_widget_id, p_tenant_id, v_local_date,
    p_retrieval_used::int, p_fallback_used::int, p_rate_limited::int,
    v_refused::int, p_guardrail_injection::int, p_guardrail_blocked_topic::int,
    p_guardrail_profanity::int, p_guardrail_nsfw::int, p_guardrail_moderation::int,
    coalesce(p_latency_ms, 0), (case when p_latency_ms is not null then 1 else 0 end)
  )
  on conflict (widget_id, stat_date) do update set
    retrieval_used_count = widget_daily_stats.retrieval_used_count + excluded.retrieval_used_count,
    fallback_chat_count = widget_daily_stats.fallback_chat_count + excluded.fallback_chat_count,
    rate_limit_hit_count = widget_daily_stats.rate_limit_hit_count + excluded.rate_limit_hit_count,
    guardrail_refusals_count = widget_daily_stats.guardrail_refusals_count + excluded.guardrail_refusals_count,
    guardrail_injection_count = widget_daily_stats.guardrail_injection_count + excluded.guardrail_injection_count,
    guardrail_blocked_topic_count = widget_daily_stats.guardrail_blocked_topic_count + excluded.guardrail_blocked_topic_count,
    guardrail_profanity_count = widget_daily_stats.guardrail_profanity_count + excluded.guardrail_profanity_count,
    guardrail_nsfw_count = widget_daily_stats.guardrail_nsfw_count + excluded.guardrail_nsfw_count,
    guardrail_moderation_count = widget_daily_stats.guardrail_moderation_count + excluded.guardrail_moderation_count,
    latency_sum_ms = widget_daily_stats.latency_sum_ms + excluded.latency_sum_ms,
    latency_sample_count = widget_daily_stats.latency_sample_count + excluded.latency_sample_count;
end;
$$;
