import type { SupabaseClient } from "@supabase/supabase-js";
import { requireSession, wireSignOut, populateSidebarWidgets, getAccessToken } from "./authGuard";

const visibilityGlobalRadio = document.querySelector<HTMLInputElement>("#embed-visibility-global")!;
const visibilitySelectedRadio = document.querySelector<HTMLInputElement>("#embed-visibility-selected")!;
const visibilityWidgetListEl = document.querySelector<HTMLElement>("#embed-visibility-widget-list")!;

interface WidgetOption {
  id: string;
  name: string;
}

async function loadWidgetOptions(supabase: SupabaseClient): Promise<void> {
  const { data } = await supabase.from("widgets").select("id, name").order("created_at", { ascending: true });
  const widgets = (data ?? []) as WidgetOption[];

  visibilityWidgetListEl.innerHTML = "";
  if (widgets.length === 0) {
    const empty = document.createElement("p");
    empty.textContent = "No other widgets yet -- create one first.";
    visibilityWidgetListEl.appendChild(empty);
    return;
  }
  for (const widget of widgets) {
    const label = document.createElement("label");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = widget.id;
    label.append(checkbox, document.createTextNode(widget.name));
    visibilityWidgetListEl.appendChild(label);
  }
}

function getVisibilitySelection(): { isGlobal: boolean; widgetIds: string[] } {
  const isGlobal = visibilityGlobalRadio.checked;
  const widgetIds = isGlobal
    ? []
    : Array.from(visibilityWidgetListEl.querySelectorAll<HTMLInputElement>("input[type=checkbox]:checked")).map((c) => c.value);
  return { isGlobal, widgetIds };
}

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
  uploadSubmitButton.disabled = selectedFiles.length === 0;

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

function updateEmbedButtonState(): void {
  submitButton.disabled = !titleInput.value.trim() || !contentInput.value.trim();
}

interface FileResult {
  filename: string;
  ok: boolean;
  error?: string;
}

// Cloudflare Workers cap total outgoing subrequests (Supabase + OpenAI calls) for a
// single invocation -- sending all N files in one request risks hitting that mid-
// batch, failing every file after whichever one happened to tip it over. Matches
// the server's own MAX_FILES_PER_REQUEST (see ingest-document-files.ts) with a
// little headroom.
const BATCH_SIZE = 8;

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

  renderFilePicker(); // starts the "Embed files" button disabled -- nothing chosen yet
  updateEmbedButtonState(); // starts the "Embed document" button disabled -- both fields start empty
  titleInput.addEventListener("input", updateEmbedButtonState);
  contentInput.addEventListener("input", updateEmbedButtonState);

  loadWidgetOptions(context.supabase);
  visibilityGlobalRadio.addEventListener("change", () => (visibilityWidgetListEl.hidden = true));
  visibilitySelectedRadio.addEventListener("change", () => (visibilityWidgetListEl.hidden = false));

  chooseFilesButton.addEventListener("click", () => filesInput.click());

  filesInput.addEventListener("change", () => {
    selectedFiles = selectedFiles.concat(Array.from(filesInput.files ?? []));
    filesInput.value = ""; // so picking the same file again later still fires a change event
    renderFilePicker();
  });

  uploadForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (selectedFiles.length === 0) return;

    const filesToEmbed = selectedFiles;
    selectedFiles = [];
    renderFilePicker(); // also disables uploadSubmitButton, since selectedFiles is now empty

    const { isGlobal, widgetIds } = getVisibilitySelection();

    const allResults: FileResult[] = [];
    for (let i = 0; i < filesToEmbed.length; i += BATCH_SIZE) {
      const batch = filesToEmbed.slice(i, i + BATCH_SIZE);
      try {
        const accessToken = await getAccessToken(context.supabase);
        if (!accessToken) throw new Error("Your session has expired. Please sign in again.");
        const body = new FormData();
        for (const file of batch) {
          body.append("files", file);
        }
        body.append("is_global", String(isGlobal));
        for (const widgetId of widgetIds) {
          body.append("widget_ids", widgetId);
        }
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
        allResults.push(...results);
      } catch (err) {
        // A whole-batch failure (session expired, network drop) still needs each of
        // that batch's files accounted for, not silently missing from the results.
        const message = err instanceof Error ? err.message : "Something went wrong.";
        for (const file of batch) {
          allResults.push({ filename: file.name, ok: false, error: message });
        }
      }
      renderResults(allResults); // progressive -- updates after every batch, not just at the very end
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
      const { isGlobal, widgetIds } = getVisibilitySelection();
      const response = await fetch("/api/ingest-document", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          title: titleInput.value.trim(),
          content: contentInput.value.trim(),
          is_global: isGlobal,
          widget_ids: widgetIds,
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
      updateEmbedButtonState();
    }
  });
}

main();
