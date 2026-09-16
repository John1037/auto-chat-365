-- widget_daily_stats (migration 0024) was created without RLS -- a real gap,
-- caught in review, not an intentional default-deny like widget_sessions/
-- rate_limit_counters. This table holds per-tenant aggregate data and needs the
-- same tenant-scoped isolation as every other multi-tenant table here.
--
-- Same pattern as tenant_documents/widgets: owner (and admin -- tenant_members has
-- no lower-privilege role today, so this matches every other owner-scoped SELECT
-- policy in this project) can SELECT their own tenant's rows; no insert/update/
-- delete policy for any client role, since the only writers are the SECURITY
-- DEFINER functions in migrations 0024/0025 and the service-role client (delete_
-- tenant_account) -- both bypass RLS entirely regardless of policy.
alter table widget_daily_stats enable row level security;

grant select on widget_daily_stats to authenticated;
grant select, insert, update, delete on widget_daily_stats to service_role;

create policy widget_daily_stats_owner_select on widget_daily_stats
  for select
  using (
    tenant_id in (select tenant_id from tenant_members where user_id = auth.uid())
  );
