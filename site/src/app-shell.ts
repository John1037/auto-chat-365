import { requireSession, wireSignOut } from "./authGuard";

// Used by pages with no other page-specific script: dashboard.html, settings.html,
// knowledge-base-analysis.html. Pages with their own logic (knowledge-base-review.ts,
// knowledge-base-embed.ts) call requireSession()/wireSignOut() directly instead of
// also loading this file, so the session check doesn't run twice per page.
async function main() {
  const context = await requireSession();
  if (!context) return; // already redirected to /login.html
  wireSignOut();
}

main();
