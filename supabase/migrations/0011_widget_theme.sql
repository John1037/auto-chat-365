-- Light/dark theme for the widget's panel body (messages, bubbles, input row --
-- the top bar's own background/logo stay separately configurable via header_color/
-- logo_url, untouched by this). 'auto' is resolved client-side at widget init via
-- prefers-color-scheme (the visitor's own OS/browser dark-mode setting) -- there's no
-- generic way to observe an arbitrary host page's own custom theme toggle, only the
-- standard browser-level signal. Defaults to 'dark' (the widget's existing look, not
-- 'auto') so no already-embedded widget changes appearance from this migration alone.

alter table widgets add column theme text not null default 'dark'
  check (theme in ('light', 'dark', 'auto'));
