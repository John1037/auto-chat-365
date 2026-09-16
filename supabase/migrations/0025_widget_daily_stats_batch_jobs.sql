-- Deferred aggregation of conversations_started/messages_count, run on a schedule
-- (see the Worker's scheduled() handler) rather than incrementally -- unlike the
-- real-time counters in migration 0024, these two ARE fully derivable after the
-- fact from the real conversations/messages tables, so a clean batch snapshot once
-- a day has definitively closed is simpler and self-correcting than careful
-- real-time bookkeeping.
--
-- "Ready" means the local day's own end (in the widget's timezone) plus a further
-- 24-hour grace period has passed -- generous padding to be certain no more
-- messages will land in a conversation that started that day (in practice a
-- conversation's realistic lifetime is bounded by how long its session token stays
-- valid, well under a day, but the grace period costs nothing and removes any doubt).
--
-- Every run recomputes a rolling 14-day lookback window rather than tracking "which
-- days have I already done" -- idempotent (safe to re-run, overwrites with the same
-- correct numbers) and self-healing (a missed run, a deploy gap, or a Worker outage
-- catches up automatically on the next run, with no separate backfill logic needed).
-- Skips days before a widget existed, so this never manufactures meaningless
-- all-zero rows for a widget's pre-history.
create function compute_widget_daily_stats() returns void
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  r record;
begin
  for r in (
    select w.id as widget_id, w.tenant_id, w.timezone, gs.day::date as stat_date
    from widgets w
    cross join generate_series(current_date - interval '14 days', current_date, interval '1 day') as gs(day)
    where gs.day::date >= (w.created_at at time zone w.timezone)::date
      and (((gs.day::date + 1)::timestamp at time zone w.timezone) + interval '24 hours') <= now()
  )
  loop
    insert into widget_daily_stats (widget_id, tenant_id, stat_date, conversations_started, messages_count)
    select
      r.widget_id,
      r.tenant_id,
      r.stat_date,
      (
        select count(*)
        from conversations c
        join widget_sessions ws on ws.id = c.session_id
        where ws.widget_id = r.widget_id
          and (c.created_at at time zone r.timezone)::date = r.stat_date
      ),
      (
        select count(*)
        from messages m
        join conversations c on c.id = m.conversation_id
        join widget_sessions ws on ws.id = c.session_id
        where ws.widget_id = r.widget_id
          and (c.created_at at time zone r.timezone)::date = r.stat_date
      )
    on conflict (widget_id, stat_date) do update set
      conversations_started = excluded.conversations_started,
      messages_count = excluded.messages_count,
      computed_at = now();
  end loop;
end;
$$;

-- Deletes conversations (and their messages) older than the owning tenant's own
-- conversation_retention_months, based on the conversation's absolute created_at
-- instant -- not a local-day concept the way daily stats bucketing is. Retention is
-- fundamentally "how long has this existed", and re-deriving which widget timezone
-- applied when a since-possibly-changed setting was active would add real
-- complexity for no practical benefit; nobody needs a purge aligned to an exact
-- local midnight.
--
-- Batched (500 conversations at a time) rather than one unbounded delete -- this
-- runs unattended on a schedule, and the first run after this feature ships could
-- otherwise face a large one-time backlog. Captures each batch's ids once into a
-- local array and reuses that same fixed set for both deletes, rather than two
-- independently-evaluated LIMIT subqueries that could in principle pick different
-- rows across the two statements.
create function purge_expired_conversations() returns void
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_batch_size int := 500;
  v_batch_ids uuid[];
begin
  loop
    select array_agg(c.id) into v_batch_ids
    from (
      select c.id
      from conversations c
      join tenants t on t.id = c.tenant_id
      where c.created_at < now() - (t.conversation_retention_months::text || ' months')::interval
      limit v_batch_size
    ) c;

    if v_batch_ids is null or array_length(v_batch_ids, 1) is null then
      exit;
    end if;

    delete from messages where conversation_id = any(v_batch_ids);
    delete from conversations where id = any(v_batch_ids);

    if array_length(v_batch_ids, 1) < v_batch_size then
      exit;
    end if;
  end loop;
end;
$$;
