-- Supports a two-pass tagging flow (see worker/src/routes/chat.ts and
-- worker/src/lib/conversationTagging.ts): a rough, fast "preliminary" tag computed
-- from just the conversation's first message (fire-and-forget, doesn't delay the
-- chat reply), later replaced by a "final" tag from the full transcript once the
-- conversation actually goes quiet. Without this column, AI Analysis had to wait up
-- to ~90 minutes (30 min quiet threshold + up to an hour until the next cron tick)
-- before a conversation showed up in any topic data at all.
alter table conversation_topics add column is_final boolean not null default false;

-- Redefines find_untagged_quiet_conversations (migrations 0028/0030) to pick up
-- quiet conversations that either have no tag yet, or only a preliminary (not yet
-- final) one -- a changed OUT-param row type isn't something CREATE OR REPLACE can
-- do, so the function has to be dropped first.
drop function if exists find_untagged_quiet_conversations(int);

create function find_untagged_quiet_conversations(p_limit int default 300)
returns table (
  conversation_id uuid,
  tenant_id uuid,
  widget_id uuid,
  conversation_date date,
  conversation_started_at timestamptz
)
  language sql
  security definer
  set search_path = public
as $$
  select c.id, c.tenant_id, ws.widget_id,
    (c.created_at at time zone coalesce(w.timezone, 'UTC'))::date,
    c.created_at
  from conversations c
  join widget_sessions ws on ws.id = c.session_id
  join widgets w on w.id = ws.widget_id
  where c.last_message_at < now() - interval '30 minutes'
    and not exists (
      select 1 from conversation_topics ct
      where ct.conversation_id = c.id and ct.is_final = true
    )
  order by c.last_message_at asc
  limit p_limit;
$$;
