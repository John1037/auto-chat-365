import type { WidgetDisplayConfig } from "./styles";

type FullConfig = WidgetDisplayConfig & { chatTitle: string; logoUrl: string | null };

const DEFAULTS: FullConfig = {
  position: "bottom-right",
  offsetX: 20,
  offsetY: 20,
  accentColor: "#468ad0",
  headerColor: "#0e1213",
  chatTitle: "Chat with us",
  logoUrl: null,
};

// Fetched once at init, before session-start -- a visitor who never opens the panel
// should never cause an anonymous auth user to be minted, so this can't piggyback on
// session-start's response. Falls back to the pre-multi-widget hardcoded look on any
// failure (network error, unknown site_key, disallowed origin) rather than blocking
// the widget from rendering at all.
export async function fetchDisplayConfig(apiBase: string, siteKey: string): Promise<FullConfig> {
  try {
    const response = await fetch(`${apiBase}/api/widget-config?site_key=${encodeURIComponent(siteKey)}`);
    if (!response.ok) return DEFAULTS;
    const data = (await response.json()) as {
      chat_title: string;
      color_scheme: string;
      position: "bottom-left" | "bottom-right";
      offset_x: number;
      offset_y: number;
      logo_url: string | null;
      header_color: string;
    };
    return {
      position: data.position === "bottom-left" ? "bottom-left" : "bottom-right",
      offsetX: data.offset_x,
      offsetY: data.offset_y,
      accentColor: data.color_scheme,
      headerColor: data.header_color,
      chatTitle: data.chat_title,
      logoUrl: data.logo_url,
    };
  } catch {
    return DEFAULTS;
  }
}
