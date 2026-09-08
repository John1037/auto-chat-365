-- Core tenancy, conversation, and message tables.

create table tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  site_key text not null unique default 'sk_live_' || gen_random_uuid(),
  allowed_origins text[] not null default '{}',
  is_active boolean not null default true,
  rate_limit_per_minute int not null default 10,
  rate_limit_daily int not null default 1000,
  created_at timestamptz not null default now()
);

-- Maps a real, authenticated Supabase Auth user (a tenant's dashboard owner) to the
-- tenant(s) they administer. Distinct from anonymous widget visitors below.
create table tenant_members (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'owner' check (role in ('owner', 'admin')),
  created_at timestamptz not null default now(),
  unique (tenant_id, user_id)
);

-- One row per anonymous widget visitor. The id is *not* a freestanding uuid — it is
-- the id of the anonymous auth.users row created for that visitor by session-start
-- (via supabase.auth.signInAnonymously()), so that a Custom Access Token Hook can look
-- up this table by auth.uid() to inject the visitor's tenant_id claim. See migration
-- 0005 and the plan's "Anonymous visitor session design" section.
create table widget_sessions (
  id uuid primary key references auth.users(id) on delete cascade,
  tenant_id uuid not null references tenants(id) on delete cascade,
  origin text,
  user_agent text,
  revoked boolean not null default false,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create index widget_sessions_tenant_id_idx on widget_sessions (tenant_id);

create table conversations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  session_id uuid not null references widget_sessions(id) on delete cascade,
  created_at timestamptz not null default now(),
  last_message_at timestamptz not null default now()
);

create index conversations_tenant_id_idx on conversations (tenant_id);
create index conversations_session_id_idx on conversations (session_id);

create table messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  -- Denormalized from conversations: cheap RLS predicates + lets Edge Functions filter
  -- explicitly by tenant_id/session_id without an extra join (defense in depth beyond RLS).
  tenant_id uuid not null,
  session_id uuid not null,
  role text not null check (role in ('user', 'assistant', 'system')),
  content text not null,
  created_at timestamptz not null default now()
);

create index messages_conversation_id_idx on messages (conversation_id);
create index messages_tenant_id_idx on messages (tenant_id);

-- Guards against the denormalized tenant_id/session_id on messages ever drifting from
-- the parent conversation's actual values.
create function messages_check_tenant_consistency() returns trigger
  language plpgsql as $$
begin
  if not exists (
    select 1 from conversations c
    where c.id = new.conversation_id
      and c.tenant_id = new.tenant_id
      and c.session_id = new.session_id
  ) then
    raise exception 'messages.tenant_id/session_id must match the parent conversation';
  end if;
  return new;
end;
$$;

create trigger messages_tenant_consistency
  before insert or update on messages
  for each row execute function messages_check_tenant_consistency();
