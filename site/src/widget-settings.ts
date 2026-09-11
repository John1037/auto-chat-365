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
}

const loadingEl = document.querySelector<HTMLElement>("#loading")!;
const errorEl = document.querySelector<HTMLElement>("#error")!;
const contentEl = document.querySelector<HTMLElement>("#content")!;
const headingEl = document.querySelector<HTMLElement>("#page-heading")!;
const form = document.querySelector<HTMLFormElement>("#settings-form")!;
const nameInput = document.querySelector<HTMLInputElement>("#name-input")!;
const chatbotNameInput = document.querySelector<HTMLInputElement>("#chatbot-name-input")!;
const chatTitleInput = document.querySelector<HTMLInputElement>("#chat-title-input")!;
const colorInput = document.querySelector<HTMLInputElement>("#color-input")!;
const logoUrlInput = document.querySelector<HTMLInputElement>("#logo-url-input")!;
const headerColorInput = document.querySelector<HTMLInputElement>("#header-color-input")!;
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
      "id, name, chatbot_name, color_scheme, chat_title, position, offset_x, offset_y, allowed_origins, site_key, logo_url, header_color",
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
  colorInput.value = widget.color_scheme;
  logoUrlInput.value = widget.logo_url ?? "";
  headerColorInput.value = widget.header_color;
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
        color_scheme: colorInput.value,
        logo_url: logoUrlInput.value.trim() || null,
        header_color: headerColorInput.value,
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
