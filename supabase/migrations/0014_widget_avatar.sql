-- Per-widget avatar image, shown above each assistant bubble alongside
-- chatbot_name (added in 0009, unused until now) -- both must be set for either to
-- render, so a tenant who only fills in one doesn't get a half-labeled message.
alter table widgets add column avatar_url text;
