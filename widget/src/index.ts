import { createWidget } from "./ui";
import { sendMessage } from "./api";

// document.currentScript is only valid during this script's own synchronous
// execution. The embed snippet uses `async`, so init() below may not run until
// DOMContentLoaded fires -- well after that window has closed -- which means
// re-reading document.currentScript from inside init() would silently get null.
// Capture it now, at the top level, before any deferral.
const scriptEl = document.currentScript as HTMLScriptElement | null;

function init() {
  if (!scriptEl) return; // can't self-locate (e.g. dynamically injected without keeping a reference) -- nothing safe to do

  const siteKey = scriptEl.dataset.siteKey;
  if (!siteKey) {
    console.error("AutoChat 365 widget: data-site-key is required on the <script> tag.");
    return;
  }

  const position = scriptEl.dataset.position === "bottom-left" ? "bottom-left" : "bottom-right";
  const apiBase = new URL(scriptEl.src).origin;

  const widget = createWidget(position);

  widget.onSend(async (message) => {
    widget.addMessage("user", message);
    widget.setTyping(true);
    try {
      const result = await sendMessage(apiBase, siteKey, message);
      widget.setTyping(false);
      widget.addMessage("assistant", result.reply);
    } catch (err) {
      widget.setTyping(false);
      widget.showError(err instanceof Error ? err.message : "Something went wrong.");
    }
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
