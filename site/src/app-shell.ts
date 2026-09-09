import { getSupabaseClient } from "./supabaseClient";
import { requireSession } from "./authGuard";

// Shared chrome for every authenticated page (dashboard/knowledge-base/settings.html):
// verifies the session (redirects to /login.html if there isn't one) and wires up
// sign-out. Page-specific content beyond this shell is each page's own concern.
async function main() {
  const context = await requireSession();
  if (!context) return; // already redirected to /login.html
}

document.querySelector<HTMLElement>("#sign-out")?.addEventListener("click", async (event) => {
  event.preventDefault();
  const supabase = await getSupabaseClient();
  await supabase.auth.signOut();
  location.href = "/";
});

main();
