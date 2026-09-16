-- Tenant-wide conversation/message retention -- deliberately per-tenant, not
-- per-widget (unlike timezone in migration 0022): a tenant reasons about how long
-- to keep visitor conversations as one policy across their whole account, not
-- per-widget. Default 13 months, not 12 -- a common, deliberate convention so a
-- tenant can always compare a given month against the same month a year ago
-- without that comparison data having just rolled off.
alter table tenants add column conversation_retention_months int not null default 13
  check (conversation_retention_months between 1 and 24);
