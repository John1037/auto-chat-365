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
const logoPreview = document.querySelector<HTMLImageElement>("#logo-preview")!;
const logoEmpty = document.querySelector<HTMLElement>("#logo-empty")!;
const logoFileInput = document.querySelector<HTMLInputElement>("#logo-file-input")!;
const logoUploadButton = document.querySelector<HTMLButtonElement>("#logo-upload-button")!;
const logoRemoveButton = document.querySelector<HTMLButtonElement>("#logo-remove-button")!;
const logoStatusEl = document.querySelector<HTMLElement>("#logo-status")!;
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

function showLogo(url: string | null): void {
  if (url) {
    logoPreview.src = url;
    logoPreview.hidden = false;
    logoEmpty.hidden = true;
    logoRemoveButton.hidden = false;
  } else {
    logoPreview.hidden = true;
    logoEmpty.hidden = false;
    logoRemoveButton.hidden = true;
  }
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
      "id, name, chatbot_name, color_scheme, chat_title, position, offset_x, offset_y, allowed_origins, site_key, logo_url, header_color, theme, greeting_message",
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
  showLogo(widget.logo_url);
  themeInput.value = widget.theme;
  positionInput.value = widget.position;
  offsetXInput.value = String(widget.offset_x);
  offsetYInput.value = String(widget.offset_y);
  originsInput.value = widget.allowed_origins.join("\n");
  snippetEl.textContent = `<script src="${location.origin}/widget.js" data-site-key="${widget.site_key}" async><\/script>`;

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

  logoUploadButton.addEventListener("click", () => logoFileInput.click());

  logoFileInput.addEventListener("change", async () => {
    const file = logoFileInput.files?.[0];
    logoFileInput.value = ""; // allow re-selecting the same file later (e.g. after fixing its size)
    if (!file) return;

    logoStatusEl.textContent = "Uploading...";
    logoStatusEl.classList.remove("error");
    logoUploadButton.disabled = true;

    try {
      const body = new FormData();
      body.append("widget_id", widgetId);
      body.append("file", file);
      const response = await fetch("/api/upload-widget-logo", {
        method: "POST",
        headers: { Authorization: `Bearer ${context.session.access_token}` },
        body,
      });
      if (!response.ok) {
        const err = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error || `upload failed (${response.status})`);
      }
      const { logo_url } = (await response.json()) as { logo_url: string };
      showLogo(logo_url);
      logoStatusEl.textContent = "Logo updated.";
    } catch (err) {
      logoStatusEl.textContent = err instanceof Error ? err.message : "Something went wrong uploading that logo.";
      logoStatusEl.classList.add("error");
    } finally {
      logoUploadButton.disabled = false;
    }
  });

  logoRemoveButton.addEventListener("click", async () => {
    logoRemoveButton.disabled = true;
    const { error: removeError } = await context.supabase.from("widgets").update({ logo_url: null }).eq("id", widgetId);
    logoRemoveButton.disabled = false;
    if (removeError) {
      logoStatusEl.textContent = "Something went wrong removing that logo.";
      logoStatusEl.classList.add("error");
      return;
    }
    showLogo(null);
    logoStatusEl.textContent = "Logo removed.";
    logoStatusEl.classList.remove("error");
  });
}

main();
