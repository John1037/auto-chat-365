export type ResolvedTheme = "light" | "dark";

export interface WidgetDisplayConfig {
  position: "bottom-left" | "bottom-right";
  offsetX: number;
  offsetY: number;
  accentColor: string;
  headerColor: string;
  theme: ResolvedTheme;
}

interface Palette {
  panelBg: string;
  panelBorder: string;
  assistantBubbleBg: string;
  assistantBubbleText: string;
  typingColor: string;
  inputBg: string;
  inputBorder: string;
  inputText: string;
  placeholderColor: string;
  poweredByColor: string;
}

// The panel body's own light/dark theme -- independent of the top bar, which keeps
// its own separately configurable header_color/logo_url regardless of this.
const PALETTES: Record<ResolvedTheme, Palette> = {
  dark: {
    panelBg: "#0e1213",
    panelBorder: "#2c3436",
    assistantBubbleBg: "#1a2022",
    assistantBubbleText: "#eef2f2",
    typingColor: "#93a1a3",
    inputBg: "#1a2022",
    inputBorder: "#2c3436",
    inputText: "#eef2f2",
    placeholderColor: "#93a1a3",
    poweredByColor: "#5c686a",
  },
  light: {
    panelBg: "#ffffff",
    panelBorder: "#dde2e3",
    assistantBubbleBg: "#f1f4f5",
    assistantBubbleText: "#14181a",
    typingColor: "#6b7677",
    inputBg: "#f5f7f7",
    inputBorder: "#d5dadb",
    inputText: "#14181a",
    placeholderColor: "#8b9596",
    poweredByColor: "#9aa3a4",
  },
};

export function widgetCss(config: WidgetDisplayConfig): string {
  const side = config.position === "bottom-left" ? "left" : "right";
  const { offsetX, offsetY, accentColor, headerColor, theme } = config;
  const p = PALETTES[theme];
  return `
    * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }

    .launcher {
      position: fixed;
      ${side}: ${offsetX}px;
      bottom: ${offsetY}px;
      width: 56px;
      height: 56px;
      border-radius: 50%;
      background: #0e1213;
      border: none;
      cursor: pointer;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 2147483000;
    }
    .launcher svg { width: 26px; height: 26px; }

    .panel {
      position: fixed;
      ${side}: ${offsetX}px;
      bottom: ${offsetY + 70}px;
      width: 340px;
      max-width: calc(100vw - 40px);
      height: 480px;
      max-height: calc(100vh - 120px);
      background: ${p.panelBg};
      border: 1px solid ${p.panelBorder};
      border-radius: 12px;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
      z-index: 2147483000;
    }
    .panel[hidden] { display: none; }

    .panel-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 12px 14px;
      border-bottom: 1px solid ${p.panelBorder};
      background: ${headerColor};
      color: #eef2f2;
      font-weight: 600;
      font-size: 14px;
      flex-shrink: 0;
    }
    .panel-header svg { width: 22px; height: 22px; flex-shrink: 0; }
    .panel-logo { width: 22px; height: 22px; flex-shrink: 0; border-radius: 4px; object-fit: contain; }
    .panel-header span { flex: 1; }
    .panel-header button {
      background: none;
      border: none;
      color: #93a1a3;
      cursor: pointer;
      font-size: 20px;
      line-height: 1;
      padding: 4px;
    }
    .panel-header button:hover { color: #eef2f2; }

    .messages {
      flex: 1;
      overflow-y: auto;
      padding: 12px 14px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .bubble {
      max-width: 85%;
      padding: 8px 12px;
      border-radius: 10px;
      font-size: 13.5px;
      line-height: 1.4;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .bubble.user { align-self: flex-end; background: ${accentColor}; color: #141a1b; }
    .bubble.assistant { align-self: flex-start; background: ${p.assistantBubbleBg}; color: ${p.assistantBubbleText}; border: 1px solid ${p.panelBorder}; }
    .bubble.typing { align-self: flex-start; color: ${p.typingColor}; font-style: italic; font-size: 13px; }

    .error-banner {
      padding: 8px 14px;
      background: rgba(224, 128, 111, 0.15);
      color: #e0806f;
      font-size: 12.5px;
      flex-shrink: 0;
    }

    .powered-by {
      text-align: center;
      font-size: 10px;
      color: ${p.poweredByColor};
      padding: 4px 0;
      flex-shrink: 0;
    }

    .input-row {
      display: flex;
      gap: 8px;
      padding: 10px;
      border-top: 1px solid ${p.panelBorder};
      flex-shrink: 0;
    }
    .input-row input {
      flex: 1;
      background: ${p.inputBg};
      border: 1px solid ${p.inputBorder};
      border-radius: 8px;
      padding: 8px 10px;
      color: ${p.inputText};
      font-size: 13.5px;
      min-width: 0;
    }
    .input-row input::placeholder { color: ${p.placeholderColor}; }
    .input-row input:focus { outline: 1px solid ${accentColor}; }
    .input-row button {
      background: ${accentColor};
      border: none;
      border-radius: 8px;
      width: 36px;
      flex-shrink: 0;
      color: #141a1b;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .input-row button:disabled { opacity: 0.5; cursor: default; }
  `;
}

export const LOGO_SVG = `
  <svg viewBox="0 0 100 100" aria-hidden="true">
    <rect x="18" y="18" width="60" height="60" rx="15" fill="#eef2f2"/>
    <rect x="52" y="52" width="34" height="34" rx="10" fill="#468ad0"/>
  </svg>
`;

export const CLOSE_ICON = "&times;";

export const SEND_ICON = `
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M4 12h14m0 0l-6-6m6 6l-6 6" fill="none" stroke="#141a1b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>
`;
