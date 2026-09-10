import { requireSession, wireSignOut } from "./authGuard";

const form = document.querySelector<HTMLFormElement>("#new-widget-form")!;
const nameInput = document.querySelector<HTMLInputElement>("#widget-name-input")!;
const statusEl = document.querySelector<HTMLElement>("#status")!;
const submitButton = form.querySelector<HTMLButtonElement>("button[type=submit]")!;

async function main() {
  const context = await requireSession();
  if (!context) return;
  wireSignOut();

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    submitButton.disabled = true;
    statusEl.textContent = "Creating...";

    try {
      const response = await fetch("/api/create-widget", {
        method: "POST",
        headers: { Authorization: `Bearer ${context.session.access_token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name: nameInput.value.trim() || undefined }),
      });
      if (!response.ok) throw new Error(`create failed (${response.status})`);
      const { widget } = (await response.json()) as { widget: { id: string } };
      location.href = `/widget-settings.html?id=${widget.id}`;
    } catch {
      statusEl.textContent = "Something went wrong creating that widget. Please try again.";
      submitButton.disabled = false;
    }
  });
}

main();
