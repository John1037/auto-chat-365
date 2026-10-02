-- AI Analysis needs hour-level date-range filters ("last 1 hour", "last 6 hours"),
-- which conversation_date (a bare DATE, resolved once per widget-local calendar day)
-- can't express. Adding the real timestamp rather than reworking conversation_date
-- itself -- conversation_date stays as-is for any future coarse day-level grouping,
-- this is purely a precision upgrade for filtering. Existing rows (tagged before this
-- column existed) get `now()` as a placeholder; every row tagged from here on carries
-- the conversation's own real start time (see conversationTagging.ts).
alter table conversation_topics add column conversation_started_at timestamptz not null default now();

create index conversation_topics_tenant_widget_started_at_idx on conversation_topics (tenant_id, widget_id, conversation_started_at);

-- Redefines find_untagged_quiet_conversations (migration 0028) to also return the
-- conversation's own created_at, so the tagging job can store the real timestamp
-- above instead of only the coarser widget-local calendar day. A changed OUT-param
-- row type isn't something CREATE OR REPLACE can do -- the function has to be
-- dropped first.
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
    and not exists (select 1 from conversation_topics ct where ct.conversation_id = c.id)
  order by c.last_message_at asc
  limit p_limit;
$$;
