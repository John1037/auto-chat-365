import { requireSession, wireSignOut, populateSidebarWidgets } from "./authGuard";

const form = document.querySelector<HTMLFormElement>("#embed-form")!;
const titleInput = document.querySelector<HTMLInputElement>("#doc-title-input")!;
const contentInput = document.querySelector<HTMLTextAreaElement>("#doc-content-input")!;
const statusEl = document.querySelector<HTMLElement>("#status")!;
const submitButton = form.querySelector<HTMLButtonElement>("button[type=submit]")!;

async function main() {
  const context = await requireSession();
  if (!context) return;
  wireSignOut();
  populateSidebarWidgets(context.supabase);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    submitButton.disabled = true;
    statusEl.textContent = "Embedding...";
    statusEl.classList.remove("error");

    try {
      const response = await fetch("/api/ingest-document", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${context.session.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          title: titleInput.value.trim(),
          content: contentInput.value.trim(),
        }),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `request failed (${response.status})`);
      }

      location.href = "/knowledge-base.html";
    } catch (err) {
      statusEl.textContent = err instanceof Error ? err.message : "Something went wrong. Please try again.";
      statusEl.classList.add("error");
      submitButton.disabled = false;
    }
  });
}

main();
