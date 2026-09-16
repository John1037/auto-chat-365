import { requireSession, wireSignOut, populateSidebarWidgets, getAccessToken } from "./authGuard";

const CONFIRMATION_PHRASE = "DELETE ACCOUNT";

const dangerZone = document.querySelector<HTMLElement>("#danger-zone")!;
const confirmInput = document.querySelector<HTMLInputElement>("#delete-confirm-input")!;
const deleteButton = document.querySelector<HTMLButtonElement>("#delete-account-button")!;
const deleteStatusEl = document.querySelector<HTMLElement>("#delete-status")!;

const retentionSection = document.querySelector<HTMLElement>("#retention-section")!;
const retentionForm = document.querySelector<HTMLFormElement>("#retention-form")!;
const retentionMonthsInput = document.querySelector<HTMLInputElement>("#retention-months-input")!;
const retentionStatusEl = document.querySelector<HTMLElement>("#retention-status")!;

async function main() {
  const context = await requireSession();
  if (!context) return; // already redirected to /login.html
  wireSignOut();
  populateSidebarWidgets(context.supabase);

  // UI gating only -- this decides whether the Danger Zone/retention form even
  // render, not whether the underlying actions are allowed. Both Worker routes
  // re-check the caller's role themselves before doing anything, the same way every
  // other client-side-hidden-but-server-enforced check in this project works.
  const { data: membership } = await context.supabase
    .from("tenant_members")
    .select("tenant_id, role")
    .eq("user_id", context.session.user.id)
    .maybeSingle();
  if (!membership || (membership.role !== "owner" && membership.role !== "admin")) return;
  dangerZone.hidden = false;
  retentionSection.hidden = false;

  // tenants' own SELECT policy allows any member (owner or admin) to read this --
  // only the UPDATE is owner-only, which is why saving goes through a dedicated
  // route below instead of a direct PostgREST update.
  const { data: tenant } = await context.supabase
    .from("tenants")
    .select("conversation_retention_months")
    .eq("id", membership.tenant_id)
    .maybeSingle();
  retentionMonthsInput.value = String(tenant?.conversation_retention_months ?? 13);

  retentionForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    retentionStatusEl.textContent = "Saving...";
    retentionStatusEl.classList.remove("error");

    try {
      const accessToken = await getAccessToken(context.supabase);
      if (!accessToken) throw new Error("Your session has expired. Please sign in again.");
      const response = await fetch("/api/update-retention-policy", {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ retention_months: Number(retentionMonthsInput.value) }),
      });
      if (!response.ok) {
        const err = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error || `save failed (${response.status})`);
      }
      retentionStatusEl.textContent = "Saved.";
    } catch (err) {
      retentionStatusEl.textContent = err instanceof Error ? err.message : "Something went wrong saving that setting.";
      retentionStatusEl.classList.add("error");
    }
  });

  confirmInput.addEventListener("input", () => {
    deleteButton.disabled = confirmInput.value !== CONFIRMATION_PHRASE;
  });

  deleteButton.addEventListener("click", async () => {
    deleteButton.disabled = true;
    confirmInput.disabled = true;
    deleteStatusEl.textContent = "Deleting your account...";
    deleteStatusEl.classList.remove("error");

    try {
      const accessToken = await getAccessToken(context.supabase);
      if (!accessToken) throw new Error("Your session has expired. Please sign in again.");
      const response = await fetch("/api/delete-tenant-account", {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ confirmation: CONFIRMATION_PHRASE }),
      });
      if (!response.ok) {
        const err = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error || `deletion failed (${response.status})`);
      }

      // The account no longer exists -- sign out to clear the now-meaningless
      // session, then leave the dashboard entirely rather than land somewhere that
      // will just fail to load data for a tenant that's gone.
      await context.supabase.auth.signOut();
      location.href = "/";
    } catch (err) {
      deleteStatusEl.textContent = err instanceof Error ? err.message : "Something went wrong deleting your account.";
      deleteStatusEl.classList.add("error");
      deleteButton.disabled = false;
      confirmInput.disabled = false;
    }
  });
}

main();
