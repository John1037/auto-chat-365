import { requireSession, wireSignOut, populateSidebarWidgets } from "./authGuard";

const uploadForm = document.querySelector<HTMLFormElement>("#upload-form")!;
const filesInput = document.querySelector<HTMLInputElement>("#doc-files-input")!;
const uploadResultsEl = document.querySelector<HTMLElement>("#upload-results")!;
const uploadSubmitButton = uploadForm.querySelector<HTMLButtonElement>("button[type=submit]")!;

const form = document.querySelector<HTMLFormElement>("#embed-form")!;
const titleInput = document.querySelector<HTMLInputElement>("#doc-title-input")!;
const contentInput = document.querySelector<HTMLTextAreaElement>("#doc-content-input")!;
const statusEl = document.querySelector<HTMLElement>("#status")!;
const submitButton = form.querySelector<HTMLButtonElement>("button[type=submit]")!;

interface FileResult {
  filename: string;
  ok: boolean;
  error?: string;
}

function renderResults(results: FileResult[]): void {
  uploadResultsEl.innerHTML = "";
  for (const result of results) {
    const item = document.createElement("li");
    item.className = `upload-result ${result.ok ? "ok" : "error"}`;

    const name = document.createElement("span");
    name.className = "upload-result-name";
    name.textContent = result.filename;

    const detail = document.createElement("span");
    detail.className = "upload-result-detail";
    detail.textContent = " — " + (result.ok ? "embedded" : result.error || "failed");

    item.append(name, detail);
    uploadResultsEl.appendChild(item);
  }
}

async function main() {
  const context = await requireSession();
  if (!context) return;
  wireSignOut();
  populateSidebarWidgets(context.supabase);

  uploadForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const files = filesInput.files;
    if (!files || files.length === 0) return;

    uploadSubmitButton.disabled = true;
    uploadResultsEl.innerHTML = "";

    try {
      const body = new FormData();
      for (const file of Array.from(files)) {
        body.append("files", file);
      }
      const response = await fetch("/api/ingest-document-files", {
        method: "POST",
        headers: { Authorization: `Bearer ${context.session.access_token}` },
        body,
      });
      if (!response.ok) {
        const err = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error || `upload failed (${response.status})`);
      }
      const { results } = (await response.json()) as { results: FileResult[] };
      renderResults(results);
      filesInput.value = "";
    } catch (err) {
      renderResults([{ filename: "Upload", ok: false, error: err instanceof Error ? err.message : "Something went wrong." }]);
    } finally {
      uploadSubmitButton.disabled = false;
    }
  });

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
