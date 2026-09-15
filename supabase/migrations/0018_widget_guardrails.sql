-- Tenant-configurable guardrail dials, per widget (not per tenant) -- these sit on
-- top of a fixed, non-configurable platform floor (prompt-injection screening,
-- secret/payment-data redaction, and hard-category content moderation, all enforced
-- in chat.ts regardless of these settings; see worker/src/lib/guardrails.ts and
-- moderation.ts). Only the tenant's own brand/commercial risk lives here, matching
-- the mandatory-vs-configurable split: disabling any of these three can only affect
-- this widget's own conversations, never another tenant, the platform, or the
-- providers behind it.
alter table widgets add column profanity_policy text not null default 'warn'
  check (profanity_policy in ('allow', 'warn', 'refuse'));

alter table widgets add column off_topic_policy text not null default 'allow'
  check (off_topic_policy in ('allow', 'strict'));

-- Free-text phrases the tenant wants the assistant to refuse to discuss (e.g. a
-- competitor's name, an unrelated regulated topic). Checked as a simple case-
-- insensitive substring match against the visitor's message before the LLM is ever
-- called -- deterministic, not merely a prompt suggestion the model could ignore.
alter table widgets add column blocked_topics text[] not null default '{}';
