import type { WidgetDisplayConfig } from "./styles";

const DEFAULTS: WidgetDisplayConfig & { chatTitle: string } = {
  position: "bottom-right",
  offsetX: 20,
  offsetY: 20,
  accentColor: "#468ad0",
  chatTitle: "Chat with us",
};

// Fetched once at init, before session-start -- a visitor who never opens the panel
// should never cause an anonymous auth user to be minted, so this can't piggyback on
// session-start's response. Falls back to the pre-multi-widget hardcoded look on any
// failure (network error, unknown site_key, disallowed origin) rather than blocking
// the widget from rendering at all.
export async function fetchDisplayConfig(apiBase: string, siteKey: string): Promise<WidgetDisplayConfig & { chatTitle: string }> {
  try {
    const response = await fetch(`${apiBase}/api/widget-config?site_key=${encodeURIComponent(siteKey)}`);
    if (!response.ok) return DEFAULTS;
    const data = (await response.json()) as {
      chat_title: string;
      color_scheme: string;
      position: "bottom-left" | "bottom-right";
      offset_x: number;
      offset_y: number;
    };
    return {
      position: data.position === "bottom-left" ? "bottom-left" : "bottom-right",
      offsetX: data.offset_x,
      offsetY: data.offset_y,
      accentColor: data.color_scheme,
      chatTitle: data.chat_title,
    };
  } catch {
    return DEFAULTS;
  }
}
