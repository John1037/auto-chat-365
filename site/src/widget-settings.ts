import type { SupabaseClient } from "@supabase/supabase-js";
import { requireSession, wireSignOut, populateSidebarWidgets } from "./authGuard";

interface WidgetRow {
  id: string;
  name: string;
  chatbot_name: string | null;
  color_scheme: string;
  chat_title: string;
  position: "bottom-right" | "bottom-left";
  offset_x: number;
  offset_y: number;
  allowed_origins: string[];
  site_key: string;
  logo_url: string | null;
  avatar_url: string | null;
  header_color: string;
  theme: "light" | "dark" | "auto";
  greeting_message: string;
}

const loadingEl = document.querySelector<HTMLElement>("#loading")!;
const errorEl = document.querySelector<HTMLElement>("#error")!;
const contentEl = document.querySelector<HTMLElement>("#content")!;
const headingEl = document.querySelector<HTMLElement>("#page-heading")!;
const form = document.querySelector<HTMLFormElement>("#settings-form")!;
const nameInput = document.querySelector<HTMLInputElement>("#name-input")!;
const chatbotNameInput = document.querySelector<HTMLInputElement>("#chatbot-name-input")!;
const chatTitleInput = document.querySelector<HTMLInputElement>("#chat-title-input")!;
const greetingInput = document.querySelector<HTMLInputElement>("#greeting-input")!;
const colorInput = document.querySelector<HTMLInputElement>("#color-input")!;
const headerColorInput = document.querySelector<HTMLInputElement>("#header-color-input")!;
const themeInput = document.querySelector<HTMLSelectElement>("#theme-input")!;
const positionInput = document.querySelector<HTMLSelectElement>("#position-input")!;
const offsetXInput = document.querySelector<HTMLInputElement>("#offset-x-input")!;
const offsetYInput = document.querySelector<HTMLInputElement>("#offset-y-input")!;
const originsInput = document.querySelector<HTMLTextAreaElement>("#origins-input")!;
const saveStatusEl = document.querySelector<HTMLElement>("#save-status")!;
const snippetEl = document.querySelector<HTMLElement>("#embed-snippet")!;

function parseOrigins(raw: string): string[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

// Shared by the logo and avatar upload controls -- identical preview/upload/remove
// behavior, differing only in which elements, API route, and widgets column each uses.
function wireImageUpload(opts: {
  prefix: string;
  uploadUrl: string;
  responseKey: string;
  column: "logo_url" | "avatar_url";
  supabase: SupabaseClient;
  widgetId: string;
  accessToken: string;
}) {
  const preview = document.querySelector<HTMLImageElement>(`#${opts.prefix}-preview`)!;
  const empty = document.querySelector<HTMLElement>(`#${opts.prefix}-empty`)!;
  const fileInput = document.querySelector<HTMLInputElement>(`#${opts.prefix}-file-input`)!;
  const uploadButton = document.querySelector<HTMLButtonElement>(`#${opts.prefix}-upload-button`)!;
  const removeButton = document.querySelector<HTMLButtonElement>(`#${opts.prefix}-remove-button`)!;
  const statusEl = document.querySelector<HTMLElement>(`#${opts.prefix}-status`)!;

  function show(url: string | null) {
    if (url) {
      preview.src = url;
      preview.hidden = false;
      empty.hidden = true;
      removeButton.hidden = false;
    } else {
      preview.hidden = true;
      empty.hidden = false;
      removeButton.hidden = true;
    }
  }

  uploadButton.addEventListener("click", () => fileInput.click());

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    fileInput.value = ""; // allow re-selecting the same file later (e.g. after fixing its size)
    if (!file) return;

    statusEl.textContent = "Uploading...";
    statusEl.classList.remove("error");
    uploadButton.disabled = true;

    try {
      const body = new FormData();
      body.append("widget_id", opts.widgetId);
      body.append("file", file);
      const response = await fetch(opts.uploadUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${opts.accessToken}` },
        body,
      });
      if (!response.ok) {
        const err = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error || `upload failed (${response.status})`);
      }
      const data = (await response.json()) as Record<string, string>;
      show(data[opts.responseKey]);
      statusEl.textContent = "Updated.";
    } catch (err) {
      statusEl.textContent = err instanceof Error ? err.message : "Something went wrong uploading that image.";
      statusEl.classList.add("error");
    } finally {
      uploadButton.disabled = false;
    }
  });

  removeButton.addEventListener("click", async () => {
    removeButton.disabled = true;
    const { error: removeError } = await opts.supabase.from("widgets").update({ [opts.column]: null }).eq("id", opts.widgetId);
    removeButton.disabled = false;
    if (removeError) {
      statusEl.textContent = "Something went wrong removing that image.";
      statusEl.classList.add("error");
      return;
    }
    show(null);
    statusEl.textContent = "Removed.";
    statusEl.classList.remove("error");
  });

  return { show };
}

async function main() {
  const context = await requireSession();
  if (!context) return;
  wireSignOut();
  populateSidebarWidgets(context.supabase);

  const widgetId = new URLSearchParams(location.search).get("id");
  if (!widgetId) {
    location.href = "/dashboard.html";
    return;
  }

  const { data, error } = await context.supabase
    .from("widgets")
    .select(
      "id, name, chatbot_name, color_scheme, chat_title, position, offset_x, offset_y, allowed_origins, site_key, logo_url, avatar_url, header_color, theme, greeting_message",
    )
    .eq("id", widgetId)
    .maybeSingle();

  if (error || !data) {
    loadingEl.hidden = true;
    errorEl.hidden = false;
    return;
  }
  const widget = data as WidgetRow;

  headingEl.textContent = widget.name;
  nameInput.value = widget.name;
  chatbotNameInput.value = widget.chatbot_name ?? "";
  chatTitleInput.value = widget.chat_title;
  greetingInput.value = widget.greeting_message;
  colorInput.value = widget.color_scheme;
  headerColorInput.value = widget.header_color;
  themeInput.value = widget.theme;
  positionInput.value = widget.position;
  offsetXInput.value = String(widget.offset_x);
  offsetYInput.value = String(widget.offset_y);
  originsInput.value = widget.allowed_origins.join("\n");
  snippetEl.textContent = `<script src="${location.origin}/widget.js" data-site-key="${widget.site_key}" async><\/script>`;

  const logoUpload = wireImageUpload({
    prefix: "logo",
    uploadUrl: "/api/upload-widget-logo",
    responseKey: "logo_url",
    column: "logo_url",
    supabase: context.supabase,
    widgetId,
    accessToken: context.session.access_token,
  });
  logoUpload.show(widget.logo_url);

  const avatarUpload = wireImageUpload({
    prefix: "avatar",
    uploadUrl: "/api/upload-widget-avatar",
    responseKey: "avatar_url",
    column: "avatar_url",
    supabase: context.supabase,
    widgetId,
    accessToken: context.session.access_token,
  });
  avatarUpload.show(widget.avatar_url);

  loadingEl.hidden = true;
  contentEl.hidden = false;

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    saveStatusEl.textContent = "Saving...";
    saveStatusEl.classList.remove("error");

    const { error: updateError } = await context.supabase
      .from("widgets")
      .update({
        name: nameInput.value.trim(),
        chatbot_name: chatbotNameInput.value.trim() || null,
        chat_title: chatTitleInput.value.trim(),
        greeting_message: greetingInput.value.trim(),
        color_scheme: colorInput.value,
        header_color: headerColorInput.value,
        theme: themeInput.value,
        position: positionInput.value,
        offset_x: Number(offsetXInput.value),
        offset_y: Number(offsetYInput.value),
        allowed_origins: parseOrigins(originsInput.value),
      })
      .eq("id", widgetId);

    if (updateError) {
      saveStatusEl.textContent = "Something went wrong saving those settings.";
      saveStatusEl.classList.add("error");
      return;
    }
    headingEl.textContent = nameInput.value.trim();
    saveStatusEl.textContent = "Saved.";
    populateSidebarWidgets(context.supabase); // reflect a renamed widget in the sidebar list
  });
}

main();
