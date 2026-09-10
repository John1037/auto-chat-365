import { requireSession, wireSignOut } from "./authGuard";

interface Widget {
  id: string;
  name: string;
  created_at: string;
  allowed_origins: string[];
}

const loadingEl = document.querySelector<HTMLElement>("#loading")!;
const errorEl = document.querySelector<HTMLElement>("#error")!;
const emptyEl = document.querySelector<HTMLElement>("#widget-empty")!;
const listEl = document.querySelector<HTMLElement>("#widget-list")!;

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function renderCard(widget: Widget): HTMLElement {
  const card = document.createElement("a");
  card.className = "widget-card";
  card.href = `/widget-settings.html?id=${widget.id}`;

  const title = document.createElement("h3");
  title.className = "widget-card-title";
  title.textContent = widget.name;

  const meta = document.createElement("p");
  meta.className = "doc-meta";
  meta.textContent = `Created ${formatDate(widget.created_at)}`;

  const origins = document.createElement("p");
  origins.className = "widget-card-origins";
  origins.textContent = widget.allowed_origins.length
    ? widget.allowed_origins.join(", ")
    : "No allowed origins set yet";

  card.append(title, meta, origins);
  return card;
}

async function main() {
  const context = await requireSession();
  if (!context) return;
  wireSignOut();

  try {
    // Idempotent get-or-create -- guarantees this tenant (and its default widget)
    // exist before we list them, same as every other page that lands here first.
    const provisionResponse = await fetch("/api/tenant-provision", {
      method: "POST",
      headers: { Authorization: `Bearer ${context.session.access_token}` },
    });
    if (!provisionResponse.ok) throw new Error(`provisioning failed (${provisionResponse.status})`);

    const { data, error } = await context.supabase
      .from("widgets")
      .select("id, name, created_at, allowed_origins")
      .order("created_at", { ascending: true });
    if (error) throw error;

    const widgets = (data ?? []) as Widget[];
    listEl.innerHTML = "";
    if (widgets.length === 0) {
      emptyEl.hidden = false;
    } else {
      for (const widget of widgets) {
        listEl.appendChild(renderCard(widget));
      }
      listEl.hidden = false;
    }

    loadingEl.hidden = true;
  } catch {
    loadingEl.hidden = true;
    errorEl.hidden = false;
  }
}

main();
