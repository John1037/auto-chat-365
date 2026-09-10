import { requireSession, wireSignOut, populateSidebarWidgets } from "./authGuard";

// Used by pages with no other page-specific script: settings.html,
// knowledge-base-analysis.html. Pages with their own logic (widgets.ts,
// knowledge-base-review.ts, etc.) call requireSession()/wireSignOut() directly
// instead of also loading this file, so the session check doesn't run twice per page.
async function main() {
  const context = await requireSession();
  if (!context) return; // already redirected to /login.html
  wireSignOut();
  populateSidebarWidgets(context.supabase);
}

main();
