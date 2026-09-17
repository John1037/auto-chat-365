-- Per-conversation topic tagging for the "AI Analysis" feature: what a session was
-- actually about, distilled to a short label + one-line gist by an LLM call once the
-- conversation has gone quiet (see the scheduled() cron handler in worker/src/index.ts
-- and worker/src/lib/conversationTagging.ts). Deliberately a separate table from
-- conversations/messages, same reasoning as widget_daily_stats (migration 0024):
-- purge_expired_conversations() deletes conversation/message rows once a tenant's
-- retention policy is reached, but this derived insight should survive that --
-- "what were customers asking about last month" needs to keep working even after the
-- raw transcripts it was drawn from have aged out. conversation_id is therefore
-- `on delete set null` rather than cascading: a purge clears the back-reference, not
-- the topic row itself.
--
-- One row per conversation (a single dominant topic, not a full breakdown) -- this
-- covers "what are people asking about" / "what's trending" well via a simple
-- group-by-topic-label count, and keeps both the tagging prompt and this schema
-- simple. Deliberately minimal for now, per the same instruction that shaped this
-- whole feature: add columns later, as and when a specific new attribute is actually
-- needed, rather than speculatively widening this table today.
create table conversation_topics (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid references conversations(id) on delete set null,
  tenant_id uuid not null references tenants(id) on delete cascade,
  widget_id uuid not null references widgets(id) on delete cascade,
  conversation_date date not null,
  topic_label text not null,
  summary text not null,
  created_at timestamptz not null default now()
);

create index conversation_topics_tenant_widget_date_idx on conversation_topics (tenant_id, widget_id, conversation_date);
create index conversation_topics_conversation_id_idx on conversation_topics (conversation_id);

alter table conversation_topics enable row level security;

grant select on conversation_topics to authenticated;
grant select, insert, update, delete on conversation_topics to service_role;

create policy conversation_topics_owner_select on conversation_topics
  for select
  using (
    tenant_id in (select tenant_id from tenant_members where user_id = auth.uid())
  );

-- Finds conversations that have gone quiet (no new message in the last 30 minutes)
-- and haven't been tagged yet -- called from the hourly cron, capped per call so a
-- large backlog is worked through over several runs rather than one huge, slow
-- invocation. Self-healing in the same sense as compute_widget_daily_stats: a missed
-- run just means the next one picks up more.
create function find_untagged_quiet_conversations(p_limit int default 300)
returns table (
  conversation_id uuid,
  tenant_id uuid,
  widget_id uuid,
  conversation_date date
)
  language sql
  security definer
  set search_path = public
as $$
  select c.id, c.tenant_id, ws.widget_id,
    (c.created_at at time zone coalesce(w.timezone, 'UTC'))::date
  from conversations c
  join widget_sessions ws on ws.id = c.session_id
  join widgets w on w.id = ws.widget_id
  where c.last_message_at < now() - interval '30 minutes'
    and not exists (select 1 from conversation_topics ct where ct.conversation_id = c.id)
  order by c.last_message_at asc
  limit p_limit;
$$;
