-- Lets a tenant opt into NSFW/adult chat -- defaults to 'refuse' (the current
-- behavior's safer superset: today nothing gates general sexual content at all,
-- since only the always-on sexual/minors floor exists; this default tightens that to
-- match what a typical business-support widget actually wants, and a tenant that
-- genuinely wants adult content has to opt in explicitly, not inherit it by
-- omission). Sexual violence, non-consent, incest, and anything involving minors
-- remain hard-blocked in code regardless of this setting -- see
-- guardrails.ts's detectHardBlockedNsfwContent and moderation.ts's sexual/minors
-- floor category -- because OpenAI's moderation API itself has no category that
-- distinguishes consensual adult content from those, so this can't be left to a
-- single coarse "sexual" score the way general profanity can.
alter table widgets add column nsfw_policy text not null default 'refuse'
  check (nsfw_policy in ('allow', 'warn', 'refuse'));
