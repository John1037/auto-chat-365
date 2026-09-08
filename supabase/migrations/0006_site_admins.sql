-- Site admins: a small set of platform operators with access to site-wide config
-- (subscription rates, per-plan tenant limits, etc.), entirely separate from
-- tenant_members' per-tenant roles. Deliberately checked live via RLS rather than
-- injected as a JWT claim -- a claim would stick around for the token's lifetime
-- (up to jwt_expiry), so revoking someone's access wouldn't take effect until their
-- session happened to refresh. A table checked on every request has no such lag.

create table site_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table site_admins enable row level security;

grant select on site_admins to authenticated;

-- Each admin can see their own row -- enough for a page to self-check "am I a site
-- admin?" without a dedicated Worker round trip. No policy sees the full list; that
-- can be added later (via the service client from a future admin-management route)
-- if/when there's an actual UI for managing other admins.
create policy site_admins_self_select on site_admins
  for select
  using (user_id = auth.uid());

-- No insert/update/delete policy for any client role, and no Edge/Worker route ever
-- writes this table either -- the only way to become a site admin is a direct SQL
-- insert against the database, on purpose. There is no API path that could grant
-- this, even accidentally.
