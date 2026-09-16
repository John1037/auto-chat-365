-- Per-widget timezone, used to bucket conversations into calendar days for daily
-- analytics (see migration 0024) -- deliberately per-widget, not per-tenant, since a
-- tenant's widgets can serve visitors in different regions.
--
-- A CHECK constraint can't reference another table/view, so a trigger validates
-- against pg_timezone_names (Postgres's own canonical IANA timezone list) instead --
-- storing an invalid zone would silently break every `AT TIME ZONE` conversion at
-- aggregation time, well after the tenant who mistyped it has moved on.
alter table widgets add column timezone text not null default 'UTC';

create function widgets_check_valid_timezone() returns trigger
  language plpgsql as $$
begin
  if not exists (select 1 from pg_timezone_names where name = new.timezone) then
    raise exception 'invalid timezone: %', new.timezone;
  end if;
  return new;
end;
$$;

create trigger widgets_valid_timezone
  before insert or update of timezone on widgets
  for each row execute function widgets_check_valid_timezone();
