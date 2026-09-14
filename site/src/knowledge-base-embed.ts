import { requireSession, wireSignOut, populateSidebarWidgets, getAccessToken } from "./authGuard";

const uploadForm = document.querySelector<HTMLFormElement>("#upload-form")!;
const filesInput = document.querySelector<HTMLInputElement>("#doc-files-input")!;
const chooseFilesButton = document.querySelector<HTMLButtonElement>("#choose-files-button")!;
const filePickerCountEl = document.querySelector<HTMLElement>("#file-picker-count")!;
const filePickerListEl = document.querySelector<HTMLElement>("#file-picker-list")!;
const uploadResultsEl = document.querySelector<HTMLElement>("#upload-results")!;
const uploadSubmitButton = document.querySelector<HTMLButtonElement>("#upload-submit-button")!;

// Picking files a second time replaces the native input's own FileList entirely
// (that's just how <input type="file"> works) -- so the actual set of files to
// embed is tracked here instead, and each "Choose files" pick is merged into it
// rather than read directly off the input at submit time.
let selectedFiles: File[] = [];

function renderFilePicker(): void {
  filePickerCountEl.textContent =
    selectedFiles.length === 0 ? "No files chosen" : selectedFiles.length === 1 ? "1 file chosen" : `${selectedFiles.length} files chosen`;

  filePickerListEl.innerHTML = "";
  selectedFiles.forEach((file, index) => {
    const item = document.createElement("li");
    item.className = "file-picker-item";

    const name = document.createElement("span");
    name.className = "file-picker-item-name";
    name.textContent = file.name;
    name.title = file.name;

    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.className = "file-picker-item-remove";
    removeButton.innerHTML = "&times;";
    removeButton.setAttribute("aria-label", `Remove ${file.name}`);
    removeButton.addEventListener("click", () => {
      selectedFiles.splice(index, 1);
      renderFilePicker();
    });

    item.append(name, removeButton);
    filePickerListEl.appendChild(item);
  });
}

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

  chooseFilesButton.addEventListener("click", () => filesInput.click());

  filesInput.addEventListener("change", () => {
    selectedFiles = selectedFiles.concat(Array.from(filesInput.files ?? []));
    filesInput.value = ""; // so picking the same file again later still fires a change event
    renderFilePicker();
  });

  uploadForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (selectedFiles.length === 0) return;

    uploadSubmitButton.disabled = true;
    uploadResultsEl.innerHTML = "";

    try {
      const body = new FormData();
      for (const file of selectedFiles) {
        body.append("files", file);
      }
      const accessToken = await getAccessToken(context.supabase);
      if (!accessToken) throw new Error("Your session has expired. Please sign in again.");
      const response = await fetch("/api/ingest-document-files", {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}` },
        body,
      });
      if (!response.ok) {
        const err = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error || `upload failed (${response.status})`);
      }
      const { results } = (await response.json()) as { results: FileResult[] };
      renderResults(results);
      selectedFiles = [];
      renderFilePicker();
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
      const accessToken = await getAccessToken(context.supabase);
      if (!accessToken) throw new Error("Your session has expired. Please sign in again.");
      const response = await fetch("/api/ingest-document", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
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
