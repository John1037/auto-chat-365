import type { SupabaseClient } from "@supabase/supabase-js";
import { requireSession, wireSignOut, populateSidebarWidgets } from "./authGuard";

interface TenantDocument {
  id: string;
  title: string;
  status: "pending" | "processing" | "ready" | "stale" | "error";
  raw_content: string;
  embedded_at: string | null;
  created_at: string;
}

const STATUS_LABEL: Record<TenantDocument["status"], string> = {
  pending: "Pending",
  processing: "Processing",
  ready: "Ready",
  stale: "Needs re-embed",
  error: "Error",
};

const ICONS = {
  expand: `<svg viewBox="0 0 24 24"><polyline points="6,9 12,15 18,9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  edit: `<svg viewBox="0 0 24 24"><path d="M4 20l1-5L16 4l4 4L9 19l-5 1z" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  reembed: `<svg viewBox="0 0 24 24"><path d="M4 4v5h5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M20 20v-5h-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M5.5 9a7 7 0 0 1 12.3-3.5M18.5 15a7 7 0 0 1-12.3 3.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
  delete: `<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
};

const listEl = document.querySelector<HTMLElement>("#doc-list")!;
const emptyEl = document.querySelector<HTMLElement>("#doc-empty")!;
const dialog = document.querySelector<HTMLDialogElement>("#edit-dialog")!;
const editForm = document.querySelector<HTMLFormElement>("#edit-form")!;
const editTitleInput = document.querySelector<HTMLInputElement>("#edit-title")!;
const editContentInput = document.querySelector<HTMLTextAreaElement>("#edit-content")!;
const editCancel = document.querySelector<HTMLButtonElement>("#edit-cancel")!;

let accessToken = "";
let editingId: string | null = null;

function formatDate(iso: string | null): string {
  if (!iso) return "Not yet embedded";
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function sample(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > 180 ? trimmed.slice(0, 180) + "…" : trimmed;
}

function iconButton(action: string, label: string, svg: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "icon-btn";
  button.dataset.action = action;
  button.dataset.tooltip = label;
  button.setAttribute("aria-label", label);
  button.innerHTML = svg;
  return button;
}

function renderCard(doc: TenantDocument): HTMLElement {
  const card = document.createElement("article");
  card.className = "doc-card";
  card.dataset.id = doc.id;

  const actions = document.createElement("div");
  actions.className = "doc-actions";
  actions.append(
    iconButton("expand", "Expand", ICONS.expand),
    iconButton("edit", "Edit", ICONS.edit),
    iconButton("reembed", "Re-embed", ICONS.reembed),
    iconButton("delete", "Delete", ICONS.delete),
  );

  const head = document.createElement("div");
  head.className = "doc-card-head";

  const title = document.createElement("h3");
  title.className = "doc-title";
  title.textContent = doc.title;
  title.title = doc.title;

  const status = document.createElement("span");
  status.className = `doc-status status-${doc.status}`;
  status.textContent = STATUS_LABEL[doc.status];

  head.append(title, status);

  const meta = document.createElement("p");
  meta.className = "doc-meta";
  meta.textContent = `Embedded ${formatDate(doc.embedded_at)}`;

  const sampleEl = document.createElement("p");
  sampleEl.className = "doc-sample";
  sampleEl.textContent = sample(doc.raw_content);

  const full = document.createElement("div");
  full.className = "doc-full";
  full.textContent = doc.raw_content;
  full.hidden = true;

  card.append(actions, head, meta, sampleEl, full);
  return card;
}

async function loadDocuments(supabase: SupabaseClient) {
  const { data, error } = await supabase
    .from("tenant_documents")
    .select("id, title, status, raw_content, embedded_at, created_at")
    .order("created_at", { ascending: false });

  listEl.innerHTML = "";
  if (error || !data || data.length === 0) {
    emptyEl.hidden = false;
    return;
  }
  emptyEl.hidden = true;
  for (const doc of data as TenantDocument[]) {
    listEl.appendChild(renderCard(doc));
  }
}

async function main() {
  const context = await requireSession();
  if (!context) return;
  wireSignOut();
  populateSidebarWidgets(context.supabase);
  accessToken = context.session.access_token;

  await loadDocuments(context.supabase);

  listEl.addEventListener("click", async (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>(".icon-btn");
    if (!button) return;
    const card = button.closest<HTMLElement>(".doc-card")!;
    const documentId = card.dataset.id!;
    const action = button.dataset.action;

    if (action === "expand") {
      const full = card.querySelector<HTMLElement>(".doc-full")!;
      full.hidden = !full.hidden;
      return;
    }

    if (action === "edit") {
      editingId = documentId;
      editTitleInput.value = card.querySelector(".doc-title")!.getAttribute("title") || "";
      editContentInput.value = card.querySelector<HTMLElement>(".doc-full")!.textContent || "";
      dialog.showModal();
      return;
    }

    if (action === "reembed") {
      button.disabled = true;
      await fetch("/api/reembed-document", {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ document_id: documentId }),
      });
      await loadDocuments(context.supabase);
      return;
    }

    if (action === "delete") {
      if (!confirm("Delete this document? This can't be undone.")) return;
      button.disabled = true;
      await fetch("/api/delete-document", {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ document_id: documentId }),
      });
      await loadDocuments(context.supabase);
      return;
    }
  });

  editCancel.addEventListener("click", () => dialog.close());

  editForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!editingId) return;
    await fetch("/api/update-document", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        document_id: editingId,
        title: editTitleInput.value.trim(),
        content: editContentInput.value.trim(),
      }),
    });
    dialog.close();
    editingId = null;
    await loadDocuments(context.supabase);
  });
}

main();
