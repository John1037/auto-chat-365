export interface WidgetDisplayConfig {
  position: "bottom-left" | "bottom-right";
  offsetX: number;
  offsetY: number;
  accentColor: string;
  headerColor: string;
}

export function widgetCss(config: WidgetDisplayConfig): string {
  const side = config.position === "bottom-left" ? "left" : "right";
  const { offsetX, offsetY, accentColor, headerColor } = config;
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
      background: #0e1213;
      border: 1px solid #2c3436;
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
      border-bottom: 1px solid #2c3436;
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
    .bubble.assistant { align-self: flex-start; background: #1a2022; color: #eef2f2; border: 1px solid #2c3436; }
    .bubble.typing { align-self: flex-start; color: #93a1a3; font-style: italic; font-size: 13px; }

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
      color: #5c686a;
      padding: 4px 0;
      flex-shrink: 0;
    }

    .input-row {
      display: flex;
      gap: 8px;
      padding: 10px;
      border-top: 1px solid #2c3436;
      flex-shrink: 0;
    }
    .input-row input {
      flex: 1;
      background: #1a2022;
      border: 1px solid #2c3436;
      border-radius: 8px;
      padding: 8px 10px;
      color: #eef2f2;
      font-size: 13.5px;
      min-width: 0;
    }
    .input-row input::placeholder { color: #93a1a3; }
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
