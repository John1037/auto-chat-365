import { requireSession, wireSignOut } from "./authGuard";

interface Tenant {
  id: string;
  name: string;
  site_key: string;
  allowed_origins: string[];
}

const loadingEl = document.querySelector<HTMLElement>("#loading")!;
const errorEl = document.querySelector<HTMLElement>("#error")!;
const contentEl = document.querySelector<HTMLElement>("#content")!;
const snippetEl = document.querySelector<HTMLElement>("#embed-snippet")!;

async function main() {
  const context = await requireSession();
  if (!context) return;
  wireSignOut();

  try {
    const response = await fetch("/api/tenant-provision", {
      method: "POST",
      headers: { Authorization: `Bearer ${context.session.access_token}` },
    });
    if (!response.ok) throw new Error(`provisioning failed (${response.status})`);
    const { tenant } = (await response.json()) as { tenant: Tenant };

    snippetEl.textContent = `<script src="${location.origin}/widget.js" data-site-key="${tenant.site_key}" data-position="bottom-right" async><\/script>`;

    loadingEl.hidden = true;
    contentEl.hidden = false;
  } catch {
    loadingEl.hidden = true;
    errorEl.hidden = false;
  }
}

main();
