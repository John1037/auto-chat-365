# AutoChat 365

**Status: work in progress.** Live in production at [autochat365.com](https://autochat365.com), with a real tenant embed running on jobsearch365.com. This document tracks what's actually built and working, not a roadmap or pitch — see "Known gaps / deferred" for what's intentionally not done yet.

## What it is

Multi-tenant chatbot-as-a-service. A business ("tenant") signs up, uploads its own knowledge base documents, and embeds a small widget script on its own site. Anonymous visitors to that site chat with a bot that answers from that tenant's documents only. Chat completions are served by DeepSeek (primary) with OpenAI as fallback; embeddings for retrieval are OpenAI.

## Architecture

- **Data plane:** Supabase (Postgres + pgvector + Auth), accessed only via the new-format API keys (`sb_publishable_...` / `sb_secret_...`). Legacy JWT `anon`/`service_role` keys are disabled on this project and treated as unavailable going forward.
- **Compute plane:** a single Cloudflare Worker (`worker/`) with a static-assets binding. It serves the marketing site, the tenant dashboard, the widget bundle, and every `/api/*` route from one deployment. An hourly Cron Trigger runs the daily-stats and retention batch jobs.
- **Widget:** a small, framework-free bundle (`widget/`) built with esbuild, embedded on tenant sites via a `<script>` snippet with a shadow-DOM root so host page styles never collide with it.
- **Dashboard:** a small multi-page site (`site/`) for signed-in tenant owners/admins — widget management, knowledge base, settings.

Tenant isolation is enforced twice, independently: Postgres RLS on every multi-tenant table, *and* explicit `tenant_id`/`session_id` filtering in every Worker query. Every cross-tenant guarantee in this repo has been verified with real signed-in sessions (not just the service-role client) hitting real local Supabase — never mocked.

## Repository layout

```
chat365/
  supabase/migrations/   -- 27 migrations, schema + RLS + SECURITY DEFINER functions
  worker/
    src/index.ts          -- router, CORS, cron (scheduled) handler
    src/routes/           -- one handler per /api/* endpoint
    src/lib/              -- supabase clients, guardrails, moderation, stats, etc.
    public/               -- static HTML pages, widget.js/site.js build output, _headers
  widget/                 -- embeddable chat widget (esbuild -> worker/public/widget.js)
  site/                   -- tenant dashboard pages (esbuild -> worker/public/*.js)
  scripts/                -- dev/ops scripts
```

## What's implemented

**Core chat flow**
- Anonymous visitor sessions via Supabase `signInAnonymously()`, tied to `widget_sessions`, tenant scoped via a Custom Access Token Hook.
- RAG chat: OpenAI embeddings for retrieval, DeepSeek for completion with an OpenAI fallback on failure, retrieved context explicitly framed as untrusted data in the system prompt (prompt-injection defense).
- Conversation history restore on page reload for a returning visitor (instead of always re-greeting).
- Markdown rendering of assistant replies (`marked` + `DOMPurify`, links forced to open in a new tab).
- Per-session and per-tenant rate limiting.

**Guardrails (two-tier)**
- Platform floor, fixed and code-enforced regardless of tenant settings: prompt-injection detection, sensitive-data redaction (card numbers, secret keys) before storage, a deterministic hard-block pattern set for the worst NSFW content (OpenAI's moderation `sexual` category alone can't distinguish consensual adult content from non-consent/incest, so this is a separate regex-based layer), and OpenAI Moderation API checks on a fixed set of hard-block categories.
- Tenant-configurable dials, exposed in widget settings: profanity policy, off-topic policy, blocked topics list, NSFW policy (allow/warn/refuse, defaults to refuse — deliberately biased toward more safety, not less, since NSFW chat is a potential future branch, not a current requirement).

**Knowledge base**
- Document ingestion (text + file upload), chunking, embedding, re-embedding, visibility toggle, deletion — all tenant-scoped.

**Tenant/widget management**
- Sign-up, tenant provisioning, widget creation, widget settings (identity, personality, appearance, guardrails, analytics, access).
- Logo/avatar upload with a client-side circular crop/zoom tool. SVG upload was removed as an accepted type (stored-XSS vector) at both the app-layer allowlist and the storage bucket's own `allowed_mime_types`.

**Analytics & retention**
- Per-widget timezone (validated against Postgres's own `pg_timezone_names`), used to resolve "which day" a conversation/message counts toward.
- `widget_daily_stats`: per-widget-per-day aggregate counts (conversations started, messages, retrieval/fallback/rate-limit/guardrail-refusal counts, latency sum+count), recorded incrementally on every chat turn and self-healingly recomputed for the last 14 days by an hourly batch job — schema deliberately leaves room for resolution-rate and HITL-escalation-rate columns to be added later without restructuring.
- Tenant-wide conversation retention policy (1–24 months, default 13, dropdown UI), enforced by an hourly purge job that deletes expired conversations+messages while the aggregate daily stats survive (anonymized performance history outlives the raw transcripts).
- RLS on `widget_daily_stats` (closed a real gap — the table shipped without it initially, caught in review and fixed).

**Account & data lifecycle**
- Tenant account self-deletion from Settings → Danger Zone: typed `"DELETE ACCOUNT"` confirmation, owner/admin-only, one transaction deleting every tenant-scoped row in dependency order (messages → conversations → rate limits → document chunks → documents → widget documents → widget sessions → members → widgets → daily stats → tenant).

**Compliance / security hardening**
- Public footer with Privacy Policy and Terms of Service links on every page, visible to non-signed-in visitors (privacy.html/terms.html are drafts, flagged inline as pending legal review).
- Security response headers (CSP, X-Frame-Options, HSTS, X-Content-Type-Options) via a `_headers` file on the static-assets binding, verified with real Playwright + Chromium listening for actual `securitypolicyviolation` events (jsdom can't enforce CSP at all, so this needed a real browser).
- A full UK-GDPR-oriented compliance pass covering data separation, lawful basis, and breach potential was completed; findings are being worked through incrementally (SVG upload, security headers, and account deletion are the items closed so far).

## Known gaps / deferred

Deliberately not built yet, by explicit decision, so nothing above had to be built in a way that would need reconstructing later:

- **Resolution rate / HITL escalation rate** tracking — waiting on the underlying features (a resolution signal, an escalate-to-human workflow) to exist first.
- **Per-conversation search/delete UI** — belongs on a tenant conversation-viewer page that doesn't exist yet; account-level deletion is available today as an interim.
- **DeepSeek international data transfer question** (UK GDPR angle, DeepSeek processing in China) — explicitly parked pending a separate decision.
- **Self-service data export / delete-my-own-data** for individual visitors — only manual/owner-driven paths exist today.
- `cleanup_rate_limit_counters()` exists in the database but isn't yet wired to the hourly cron.
- privacy.html/terms.html are functional placeholders, not final legal copy.

## Local development

```
npm install                 # installs the workspace (widget, site, worker)
npm run build                # builds widget + site bundles into worker/public/
npm run dev                  # build, then wrangler dev against worker/wrangler.jsonc
```

Requires a local Supabase stack (`supabase start`, then `supabase db reset` to apply all migrations) and a `worker/.dev.vars` file (see `.env.example`) with local Supabase URL/keys plus real `OPENAI_API_KEY`/`DEEPSEEK_API_KEY` values — this project's convention is to test everything against real local Postgres and real external APIs, never mocks.
