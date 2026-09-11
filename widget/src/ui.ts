import { widgetCss, LOGO_SVG, CLOSE_ICON, SEND_ICON, type WidgetDisplayConfig } from "./styles";

export interface Widget {
  addMessage(role: "user" | "assistant", text: string): void;
  setTyping(typing: boolean): void;
  showError(message: string): void;
  onSend(handler: (message: string) => void): void;
}

export function createWidget(config: WidgetDisplayConfig & { chatTitle: string; logoUrl: string | null }): Widget {
  const host = document.createElement("div");
  host.id = "autochat365-widget-root";
  const shadow = host.attachShadow({ mode: "open" });

  const style = document.createElement("style");
  style.textContent = widgetCss(config);
  shadow.appendChild(style);

  const launcher = document.createElement("button");
  launcher.className = "launcher";
  launcher.setAttribute("aria-label", "Open chat");
  launcher.innerHTML = LOGO_SVG;

  const panel = document.createElement("div");
  panel.className = "panel";
  panel.hidden = true;

  const header = document.createElement("div");
  header.className = "panel-header";
  const headerTitle = document.createElement("span");
  headerTitle.textContent = config.chatTitle;
  const closeButton = document.createElement("button");
  closeButton.innerHTML = CLOSE_ICON;
  closeButton.setAttribute("aria-label", "Close chat");
  if (config.logoUrl) {
    const logo = document.createElement("img");
    logo.className = "panel-logo";
    logo.src = config.logoUrl;
    logo.alt = "";
    header.appendChild(logo);
  } else {
    header.innerHTML = LOGO_SVG;
  }
  header.append(headerTitle, closeButton);

  const messages = document.createElement("div");
  messages.className = "messages";

  const errorBanner = document.createElement("div");
  errorBanner.className = "error-banner";
  errorBanner.hidden = true;

  const poweredBy = document.createElement("div");
  poweredBy.className = "powered-by";
  poweredBy.textContent = "Powered by 365 Applications";

  const inputRow = document.createElement("form");
  inputRow.className = "input-row";
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "Type a message...";
  input.autocomplete = "off";
  const sendButton = document.createElement("button");
  sendButton.type = "submit";
  sendButton.innerHTML = SEND_ICON;
  sendButton.setAttribute("aria-label", "Send");
  inputRow.append(input, sendButton);

  panel.append(header, messages, errorBanner, poweredBy, inputRow);

  launcher.addEventListener("click", () => {
    panel.hidden = !panel.hidden;
    if (!panel.hidden) input.focus();
  });
  closeButton.addEventListener("click", () => {
    panel.hidden = true;
  });

  shadow.append(launcher, panel);
  document.body.appendChild(host);

  let sendHandler: ((message: string) => void) | null = null;
  inputRow.addEventListener("submit", (event) => {
    event.preventDefault();
    const value = input.value.trim();
    if (!value || !sendHandler) return;
    input.value = "";
    sendHandler(value);
  });

  return {
    addMessage(role, text) {
      const bubble = document.createElement("div");
      bubble.className = `bubble ${role}`;
      bubble.textContent = text;
      messages.appendChild(bubble);
      messages.scrollTop = messages.scrollHeight;
    },
    setTyping(typing) {
      const existing = messages.querySelector(".bubble.typing");
      if (typing && !existing) {
        const bubble = document.createElement("div");
        bubble.className = "bubble typing";
        bubble.textContent = "Typing...";
        messages.appendChild(bubble);
        messages.scrollTop = messages.scrollHeight;
      } else if (!typing && existing) {
        existing.remove();
      }
      sendButton.disabled = typing;
      input.disabled = typing;
    },
    showError(message) {
      errorBanner.textContent = message;
      errorBanner.hidden = false;
    },
    onSend(handler) {
      sendHandler = handler;
    },
  };
}
