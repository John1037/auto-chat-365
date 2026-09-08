-- Row Level Security: the actual tenant-isolation boundary. Every tenant-scoped table
-- gets RLS enabled here; a table with RLS enabled and no matching policy denies by
-- default for every role except one with BYPASSRLS (the secret-key/service_role client
-- used inside Edge Functions).

alter table tenants enable row level security;
alter table tenant_members enable row level security;
alter table widget_sessions enable row level security;
alter table conversations enable row level security;
alter table messages enable row level security;
alter table tenant_documents enable row level security;
alter table tenant_document_chunks enable row level security;
alter table rate_limit_counters enable row level security;

-- ---------------------------------------------------------------------------
-- Base table privileges. RLS policies only *restrict* what a grant already allows --
-- Postgres denies access outright to a role with no grant at all, regardless of RLS.
-- Every anonymous widget visitor authenticates (via signInAnonymously) before touching
-- any of these tables, so they always hold the `authenticated` role -- the bare `anon`
-- role (an unauthenticated request using only the publishable key) is never used
-- against these tables and gets no grants at all, matching the "no policy" default
-- deny on widget_sessions/rate_limit_counters.
-- ---------------------------------------------------------------------------

grant select, update on tenants to authenticated;
grant select on tenant_members to authenticated;
grant select, insert on conversations to authenticated;
grant select, insert on messages to authenticated;
grant select on tenant_documents to authenticated;
grant select on tenant_document_chunks to authenticated;

-- ---------------------------------------------------------------------------
-- tenants: no client-role policy at all. Edge Functions read this exclusively via
-- the secret-key client (bypasses RLS). Dashboard owners can view/update their own
-- tenant's settings (e.g. allowed_origins) directly via PostgREST.
-- ---------------------------------------------------------------------------

create policy tenants_owner_select on tenants
  for select
  using (
    id in (select tenant_id from tenant_members where user_id = auth.uid())
  );

create policy tenants_owner_update on tenants
  for update
  using (
    id in (select tenant_id from tenant_members where user_id = auth.uid() and role = 'owner')
  )
  with check (
    id in (select tenant_id from tenant_members where user_id = auth.uid() and role = 'owner')
  );

-- ---------------------------------------------------------------------------
-- tenant_members: a user can see their own memberships (which tenants they belong to
-- and with what role). Writes only via the tenant-provision Edge Function.
-- ---------------------------------------------------------------------------

create policy tenant_members_self_select on tenant_members
  for select
  using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- widget_sessions: default-deny for every client role. Written only by
-- session-start/chat via the secret-key client.
-- ---------------------------------------------------------------------------

-- (No policies. RLS is enabled above; that alone denies all client-role access.)

-- ---------------------------------------------------------------------------
-- conversations: an anonymous widget visitor may read/create only their own
-- conversation(s) within their own tenant. A tenant owner may read (but not write)
-- every conversation belonging to their tenant, e.g. for a transcripts view.
-- ---------------------------------------------------------------------------

create policy conversations_visitor_select on conversations
  for select
  using (
    tenant_id = (auth.jwt() ->> 'tenant_id')::uuid
    and session_id = auth.uid()
  );

create policy conversations_visitor_insert on conversations
  for insert
  with check (
    tenant_id = (auth.jwt() ->> 'tenant_id')::uuid
    and session_id = auth.uid()
  );

create policy conversations_owner_select on conversations
  for select
  using (
    tenant_id in (select tenant_id from tenant_members where user_id = auth.uid())
  );

-- ---------------------------------------------------------------------------
-- messages: same visitor scoping as conversations, plus a visitor may only ever
-- insert role='user' rows — assistant/system rows are only ever written by the chat
-- Edge Function via the secret-key client. This means even a stolen/replayed visitor
-- token can't be used to inject fake assistant messages into a transcript.
-- ---------------------------------------------------------------------------

create policy messages_visitor_select on messages
  for select
  using (
    tenant_id = (auth.jwt() ->> 'tenant_id')::uuid
    and session_id = auth.uid()
  );

create policy messages_visitor_insert on messages
  for insert
  with check (
    tenant_id = (auth.jwt() ->> 'tenant_id')::uuid
    and session_id = auth.uid()
    and role = 'user'
  );

create policy messages_owner_select on messages
  for select
  using (
    tenant_id in (select tenant_id from tenant_members where user_id = auth.uid())
  );

-- ---------------------------------------------------------------------------
-- tenant_documents / tenant_document_chunks: owner-readable only. All writes
-- (chunking + embedding) go through ingest-document/delete-document via the
-- secret-key client, so there are deliberately no insert/update/delete policies for
-- any client role here.
-- ---------------------------------------------------------------------------

create policy tenant_documents_owner_select on tenant_documents
  for select
  using (
    tenant_id in (select tenant_id from tenant_members where user_id = auth.uid())
  );

create policy tenant_document_chunks_owner_select on tenant_document_chunks
  for select
  using (
    tenant_id in (select tenant_id from tenant_members where user_id = auth.uid())
  );

-- ---------------------------------------------------------------------------
-- rate_limit_counters: no client-role policies at all. SECURITY DEFINER function
-- (check_and_increment_rate_limit) and the secret-key client are the only writers.
-- ---------------------------------------------------------------------------

-- (No policies.)
