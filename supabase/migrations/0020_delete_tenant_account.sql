-- Full, irreversible tenant account deletion. A single SECURITY DEFINER function,
-- not a sequence of separate deletes from the Worker, so the whole thing runs in one
-- transaction -- either the entire tenant is gone, or (on any error) none of it is.
-- A partial deletion (e.g. widgets gone but the tenants row still present) would
-- leave the account in a broken, inconsistent state with no way back.
--
-- Deletes are ordered children-before-parents so each one is a real, explicit,
-- tenant_id-scoped statement rather than leaning on FK cascade to do the actual
-- work (cascades are still in place as a second layer, but this function doesn't
-- depend on them). rate_limit_counters has no FK to tenants at all, so it would
-- never be cleaned up by cascade regardless -- it must be deleted explicitly here.
--
-- Authorization (caller must be an owner/admin member of this exact tenant) is the
-- Worker route's job, not this function's -- same division as every other
-- privileged operation in this project (see delete-tenant-account.ts).
create function public.delete_tenant_account(p_tenant_id uuid) returns void
  language plpgsql
  security definer
  set search_path = public
as $$
begin
  delete from messages where tenant_id = p_tenant_id;
  delete from conversations where tenant_id = p_tenant_id;
  delete from rate_limit_counters where tenant_id = p_tenant_id;
  delete from tenant_document_chunks where tenant_id = p_tenant_id;
  delete from tenant_documents where tenant_id = p_tenant_id;
  delete from widget_documents where widget_id in (select id from widgets where tenant_id = p_tenant_id);
  delete from widget_sessions where tenant_id = p_tenant_id;
  delete from tenant_members where tenant_id = p_tenant_id;
  delete from widgets where tenant_id = p_tenant_id;
  delete from tenants where id = p_tenant_id;
end;
$$;

-- No grant to authenticated/anon: this is callable only via the Worker's
-- service-role client, same as every other privileged write path in this project.
