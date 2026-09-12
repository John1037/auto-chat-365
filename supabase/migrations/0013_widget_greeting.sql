-- Optional greeting bubble shown in the widget panel before any real conversation
-- starts. Client-side only (never touches conversations/messages) -- purely a
-- static first bubble the widget itself renders at init. Tenant can clear it to an
-- empty string to disable the greeting entirely.
alter table widgets add column greeting_message text not null default 'Hi, how can we help?';
