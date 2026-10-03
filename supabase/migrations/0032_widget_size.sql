-- Lets a tenant independently scale up the widget's floating launcher icon and the
-- chat window itself, from their current/default size (0) up to double that size
-- (100 = +100%). Stored as a percentage increase, not an absolute pixel size, so the
-- widget bundle's own base dimensions (see widget/src/styles.ts) stay the single
-- source of truth for "default" -- this is purely a multiplier on top of them.
alter table widgets add column icon_scale_pct int not null default 0 check (icon_scale_pct between 0 and 100);
alter table widgets add column window_scale_pct int not null default 0 check (window_scale_pct between 0 and 100);
