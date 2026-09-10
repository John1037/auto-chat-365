-- Per-widget display settings, editable by the tenant owner in the dashboard.
-- Position moves here from the embed snippet's data-position attribute -- a tenant
-- changing it in the dashboard shouldn't require them to re-edit their own site's
-- HTML, so the widget script fetches this at runtime instead (see the new public
-- /api/widget-config route).

alter table widgets add column chatbot_name text;
alter table widgets add column color_scheme text not null default '#468ad0';
alter table widgets add column chat_title text not null default 'Chat with us';
alter table widgets add column position text not null default 'bottom-right'
  check (position in ('bottom-right', 'bottom-left'));
alter table widgets add column offset_x int not null default 20;
alter table widgets add column offset_y int not null default 20;

-- Creating a widget goes through a Worker route (create-widget), not a direct
-- client insert -- same reasoning 0008 already left in place: deriving tenant_id
-- from tenant_members server-side, rather than trusting a client-supplied value
-- under an RLS WITH CHECK, keeps every mutation path consistent (see
-- tenant-provision.ts, ingest-document.ts). widgets_owner_update already lets a
-- client edit these new settings columns directly, same as name/allowed_origins.
