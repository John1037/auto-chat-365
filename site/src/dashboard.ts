import { getSupabaseClient } from "./supabaseClient";

interface Tenant {
  id: string;
  name: string;
  site_key: string;
  allowed_origins: string[];
}

const loadingEl = document.querySelector<HTMLElement>("#loading")!;
const contentEl = document.querySelector<HTMLElement>("#content")!;
const errorEl = document.querySelector<HTMLElement>("#error")!;
const tenantNameEl = document.querySelector<HTMLElement>("#tenant-name")!;
const snippetEl = document.querySelector<HTMLElement>("#embed-snippet")!;
const signOutButton = document.querySelector<HTMLButtonElement>("#sign-out")!;

async function main() {
  const supabase = await getSupabaseClient();

  // getSession() waits for supabase-js's own detection of a magic-link redirect in
  // the URL (access token / PKCE code) to finish before resolving, so this is safe to
  // call immediately regardless of whether we just landed here from the email link or
  // are revisiting with an existing session.
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session) {
    location.href = "/login.html";
    return;
  }

  // Clean the magic-link token/code out of the URL now that the session is
  // established -- purely cosmetic, but avoids leaving a sensitive-looking fragment
  // visible/bookmarkable.
  history.replaceState({}, "", "/dashboard.html");

  try {
    const response = await fetch("/api/tenant-provision", {
      method: "POST",
      headers: { Authorization: `Bearer ${session.access_token}` },
    });
    if (!response.ok) {
      throw new Error(`provisioning failed (${response.status})`);
    }
    const { tenant } = (await response.json()) as { tenant: Tenant };

    tenantNameEl.textContent = tenant.name;
    snippetEl.textContent = `<script src="${location.origin}/widget.js" data-site-key="${tenant.site_key}" data-position="bottom-right" async><\/script>`;

    loadingEl.hidden = true;
    contentEl.hidden = false;
  } catch {
    loadingEl.hidden = true;
    errorEl.hidden = false;
  }
}

signOutButton.addEventListener("click", async () => {
  const supabase = await getSupabaseClient();
  await supabase.auth.signOut();
  location.href = "/";
});

main();
