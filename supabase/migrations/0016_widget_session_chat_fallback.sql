-- Once DeepSeek fails for a given visitor session, remember it for the rest of that
-- session so subsequent messages go straight to the OpenAI fallback instead of
-- paying DeepSeek's own timeout again on every single message (see chat.ts). Scoped
-- to the session, not the widget or tenant, so a transient DeepSeek blip for one
-- visitor doesn't affect anyone else's chat, and a fresh session (new visitor, or
-- this one much later) tries DeepSeek again from scratch.
alter table widget_sessions add column use_fallback_chat boolean not null default false;
