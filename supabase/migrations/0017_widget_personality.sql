-- Lets a tenant steer how their chatbot sounds without touching the underlying
-- system prompt -- three independent dials folded into chat.ts's system prompt at
-- send time (tone, technical depth, and length), rather than one free-text field,
-- so results stay predictable and the dashboard can offer a fixed dropdown per axis.
-- Defaults match the assistant's existing behavior before this migration (a plain
-- "helpful assistant" with no explicit style/length guidance), so no already-embedded
-- widget's tone changes just from this migration landing.
alter table widgets add column character_style text not null default 'helpful'
  check (character_style in (
    'empathetic', 'sympathetic', 'friendly', 'cheerful', 'salesman',
    'helpful', 'apologetic', 'informative', 'enthusiastic'
  ));

alter table widgets add column response_style text not null default 'balanced'
  check (response_style in ('technical', 'balanced', 'non-technical'));

alter table widgets add column response_length text not null default 'normal'
  check (response_length in ('terse', 'concise', 'normal', 'verbose'));
