-- Redefines delete_tenant_account (see migrations 0020/0026) to also remove
-- conversation_topics -- "delete everything, unrecoverably" applies to derived
-- insight (topic tags) the same as it does to raw transcripts and aggregate stats,
-- even though conversation_topics is deliberately designed to outlive individual
-- conversations under the tenant's own retention policy (see migration 0028). Account
-- deletion is a different, stronger promise than retention: everything, not
-- everything-except-analytics.
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
  delete from conversation_topics where tenant_id = p_tenant_id;
  delete from tenant_document_chunks where tenant_id = p_tenant_id;
  delete from tenant_documents where tenant_id = p_tenant_id;
  delete from widget_documents where widget_id in (select id from widgets where tenant_id = p_tenant_id);
  delete from widget_sessions where tenant_id = p_tenant_id;
  delete from tenant_members where tenant_id = p_tenant_id;
  delete from widgets where tenant_id = p_tenant_id;
  delete from tenants where id = p_tenant_id;
end;
$$;
