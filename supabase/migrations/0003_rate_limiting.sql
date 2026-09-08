-- Fixed-window rate limiting, checked per-request by Edge Functions.
-- No client role ever reads/writes this table directly (see RLS migration).

create table rate_limit_counters (
  tenant_id uuid not null,
  scope text not null check (scope in ('tenant', 'session')),
  scope_key text not null,
  window_start timestamptz not null,
  request_count int not null default 1,
  primary key (tenant_id, scope, scope_key, window_start)
);

-- Atomically increments the counter for (tenant_id, scope, scope_key) in the current
-- fixed window of p_window_seconds, and returns whether the caller is still within
-- p_limit for that window. Called once per scope (e.g. 'session' and 'tenant') per
-- chat turn.
create function check_and_increment_rate_limit(
  p_tenant_id uuid,
  p_scope text,
  p_scope_key text,
  p_window_seconds int,
  p_limit int
) returns boolean
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_window timestamptz;
  v_count int;
begin
  v_window := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);

  insert into rate_limit_counters (tenant_id, scope, scope_key, window_start, request_count)
  values (p_tenant_id, p_scope, p_scope_key, v_window, 1)
  on conflict (tenant_id, scope, scope_key, window_start)
  do update set request_count = rate_limit_counters.request_count + 1
  returning request_count into v_count;

  return v_count <= p_limit;
end;
$$;

-- Prunes counters old enough that no live window could still reference them.
-- Invoke periodically (pg_cron or a scheduled Edge Function) — not run automatically.
create function cleanup_rate_limit_counters() returns void
  language sql
  security definer
  set search_path = public
as $$
  delete from rate_limit_counters where window_start < now() - interval '2 days';
$$;
