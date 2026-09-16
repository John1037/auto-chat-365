-- Redefines delete_tenant_account (see migration 0020) to also remove
-- widget_daily_stats -- that table's own on delete cascade FKs would eventually
-- catch this once widgets/tenants are gone anyway, but this project deliberately
-- doesn't rely on cascade alone for this function; every table gets its own
-- explicit, tenant_id-scoped delete, in dependency order (children first).
create or replace function public.delete_tenant_account(p_tenant_id uuid) returns void
  language plpgsql
  security definer
  set search_path = public
as $$
begin
  delete from messages where tenant_id = p_tenant_id;
  delete from conversations where tenant_id = p_tenant_id;
  delete from rate_limit_counters where tenant_id = p_tenant_id;
  delete from widget_daily_stats where tenant_id = p_tenant_id;
  delete from tenant_document_chunks where tenant_id = p_tenant_id;
  delete from tenant_documents where tenant_id = p_tenant_id;
  delete from widget_documents where widget_id in (select id from widgets where tenant_id = p_tenant_id);
  delete from widget_sessions where tenant_id = p_tenant_id;
  delete from tenant_members where tenant_id = p_tenant_id;
  delete from widgets where tenant_id = p_tenant_id;
  delete from tenants where id = p_tenant_id;
end;
$$;
