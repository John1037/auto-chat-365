-- Widget top-bar branding: a tenant's own logo image (replacing the default
-- AutoChat 365 mark) and a background color for the header distinct from
-- color_scheme (which drives the accent elsewhere -- user bubble, send button).
-- logo_url is a plain image URL for now, not an upload -- same "keep it simple"
-- approach as every other widget setting so far; a real upload pipeline (Storage
-- bucket + RLS) is a bigger step to take only once this turns out not to be enough.

alter table widgets add column logo_url text;
alter table widgets add column header_color text not null default '#0e1213';
