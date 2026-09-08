-- Injects a `tenant_id` claim into the access token issued for an anonymous widget
-- visitor, by looking up the widget_sessions row keyed by that visitor's own
-- auth.users id (see 0001_core_schema.sql). Must be wired up as the project's Custom
-- Access Token Hook (Dashboard -> Authentication -> Hooks, or
-- [auth.hook.custom_access_token] in supabase/config.toml) before session-start/chat
-- will work end-to-end -- this migration only creates the function, it does not
-- register it as the active hook.
--
-- If the session has been revoked, no tenant_id claim is injected, which makes every
-- RLS predicate that checks tenant_id = (auth.jwt()->>'tenant_id')::uuid fail closed
-- for that visitor.

create function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
as $$
declare
  claims jsonb;
  v_tenant_id uuid;
begin
  select tenant_id into v_tenant_id
  from public.widget_sessions
  where id = (event ->> 'user_id')::uuid
    and revoked = false;

  claims := event -> 'claims';

  if v_tenant_id is not null then
    claims := jsonb_set(claims, '{tenant_id}', to_jsonb(v_tenant_id::text));
  end if;

  event := jsonb_set(event, '{claims}', claims);
  return event;
end;
$$;

-- GoTrue calls this function as the supabase_auth_admin role, which is not a
-- superuser and does not bypass RLS -- grant it exactly what it needs, explicitly,
-- rather than relying on table-ownership bypass.

grant usage on schema public to supabase_auth_admin;

grant execute
  on function public.custom_access_token_hook
  to supabase_auth_admin;

revoke execute
  on function public.custom_access_token_hook
  from authenticated, anon, public;

grant select
  on table public.widget_sessions
  to supabase_auth_admin;

create policy widget_sessions_auth_admin_select on public.widget_sessions
  as permissive
  for select
  to supabase_auth_admin
  using (true);
