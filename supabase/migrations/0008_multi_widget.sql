-- A tenant can now run several distinct widgets (different embeds, different
-- allowed_origins/rate limits), each with its own site_key. What used to live
-- directly on tenants moves to this new child table.

create table widgets (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null default 'Default widget',
  site_key text not null unique default 'sk_live_' || gen_random_uuid(),
  allowed_origins text[] not null default '{}',
  rate_limit_per_minute int not null default 10,
  rate_limit_daily int not null default 1000,
  created_at timestamptz not null default now()
);

create index widgets_tenant_id_idx on widgets (tenant_id);

-- Migrate every existing tenant's per-tenant config onto exactly one widget,
-- preserving the existing site_key verbatim -- any embed snippet already live on a
-- real site keeps working unchanged, it's just looked up via `widgets` now instead
-- of `tenants`.
insert into widgets (tenant_id, name, site_key, allowed_origins, rate_limit_per_minute, rate_limit_daily)
select id, 'Default widget', site_key, allowed_origins, rate_limit_per_minute, rate_limit_daily
from tenants;

alter table tenants drop column site_key;
alter table tenants drop column allowed_origins;
alter table tenants drop column rate_limit_per_minute;
alter table tenants drop column rate_limit_daily;

-- widget_sessions now belongs to a specific widget. tenant_id stays (denormalized,
-- same pattern used everywhere else in this schema) for cheap RLS predicates and
-- defense-in-depth filters without an extra join.
alter table widget_sessions add column widget_id uuid references widgets(id) on delete cascade;

update widget_sessions ws set widget_id = w.id
  from widgets w where w.tenant_id = ws.tenant_id;

alter table widget_sessions alter column widget_id set not null;

-- Document-to-widget visibility. Global by default -- every document that already
-- exists stays visible to its tenant's widget(s), no behavior change today.
-- Restricting a document to specific widgets is expressed via widget_documents;
-- there's no picker UI for this yet (not useful until a tenant actually has more
-- than one widget to choose between), but the data model supports it now.
alter table tenant_documents add column is_global boolean not null default true;

create table widget_documents (
  widget_id uuid not null references widgets(id) on delete cascade,
  document_id uuid not null references tenant_documents(id) on delete cascade,
  primary key (widget_id, document_id)
);

create function widget_documents_check_tenant_consistency() returns trigger
  language plpgsql as $$
declare
  v_widget_tenant uuid;
  v_doc_tenant uuid;
begin
  select tenant_id into v_widget_tenant from widgets where id = new.widget_id;
  select tenant_id into v_doc_tenant from tenant_documents where id = new.document_id;
  if v_widget_tenant is null or v_doc_tenant is null or v_widget_tenant != v_doc_tenant then
    raise exception 'widget_documents: widget and document must belong to the same tenant';
  end if;
  return new;
end;
$$;

create trigger widget_documents_tenant_consistency
  before insert or update on widget_documents
  for each row execute function widget_documents_check_tenant_consistency();

-- Replaces the M4 version (uuid, vector, int) with a widget-aware one: a chunk is
-- visible if its document is global, OR explicitly linked to the requesting widget.
drop function match_tenant_document_chunks(uuid, vector, int);

create function match_tenant_document_chunks(
  p_tenant_id uuid,
  p_widget_id uuid,
  p_query_embedding vector(1536),
  p_match_count int
) returns table (
  id uuid,
  document_id uuid,
  content text,
  similarity float
)
  language sql
  security definer
  set search_path = public
as $$
  select c.id, c.document_id, c.content, 1 - (c.embedding <=> p_query_embedding) as similarity
  from tenant_document_chunks c
  join tenant_documents d on d.id = c.document_id
  where c.tenant_id = p_tenant_id
    and (
      d.is_global
      or exists (
        select 1 from widget_documents wd
        where wd.widget_id = p_widget_id and wd.document_id = c.document_id
      )
    )
  order by c.embedding <=> p_query_embedding
  limit p_match_count;
$$;

-- RLS: owners can see their own tenant's widgets and update settings like name/
-- allowed_origins directly (same pattern tenants_owner_update already uses) --
-- creating/deleting widgets goes through a Worker route later, not exposed here yet.
alter table widgets enable row level security;
alter table widget_documents enable row level security;

grant select, update on widgets to authenticated;
grant select on widget_documents to authenticated;
grant select, insert, update, delete on widgets, widget_documents to service_role;

create policy widgets_owner_select on widgets
  for select
  using (tenant_id in (select tenant_id from tenant_members where user_id = auth.uid()));

create policy widgets_owner_update on widgets
  for update
  using (tenant_id in (select tenant_id from tenant_members where user_id = auth.uid()))
  with check (tenant_id in (select tenant_id from tenant_members where user_id = auth.uid()));

create policy widget_documents_owner_select on widget_documents
  for select
  using (
    widget_id in (
      select w.id from widgets w
      join tenant_members tm on tm.tenant_id = w.tenant_id
      where tm.user_id = auth.uid()
    )
  );
