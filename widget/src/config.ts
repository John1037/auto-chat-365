import type { WidgetDisplayConfig, ResolvedTheme } from "./styles";

type FullConfig = WidgetDisplayConfig & { chatTitle: string; logoUrl: string | null; greetingMessage: string };

const DEFAULTS: FullConfig = {
  position: "bottom-right",
  offsetX: 20,
  offsetY: 20,
  accentColor: "#468ad0",
  headerColor: "#0e1213",
  theme: "dark",
  chatTitle: "Chat with us",
  logoUrl: null,
  greetingMessage: "Hi, how can we help?",
};

// "auto" means match the visitor's own OS/browser dark-mode setting
// (prefers-color-scheme) -- there's no generic way to observe an arbitrary host
// page's own custom theme toggle instead, only this standard browser-level signal.
// Resolved once at init, not kept live: if the visitor's OS theme changes while the
// page is open, the widget won't re-render until next load. Good enough for a chat
// widget, and far simpler than re-running this on a matchMedia listener.
function resolveTheme(theme: "light" | "dark" | "auto"): ResolvedTheme {
  if (theme !== "auto") return theme;
  const prefersDark = typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;
  return prefersDark ? "dark" : "light";
}

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
      theme: "light" | "dark" | "auto";
      greeting_message: string;
    };
    return {
      position: data.position === "bottom-left" ? "bottom-left" : "bottom-right",
      offsetX: data.offset_x,
      offsetY: data.offset_y,
      accentColor: data.color_scheme,
      headerColor: data.header_color,
      theme: resolveTheme(data.theme),
      chatTitle: data.chat_title,
      logoUrl: data.logo_url,
      greetingMessage: data.greeting_message,
    };
  } catch {
    return DEFAULTS;
  }
}
