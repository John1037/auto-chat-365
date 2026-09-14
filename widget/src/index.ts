import { createWidget, type Widget } from "./ui";
import { sendMessage } from "./api";
import { fetchDisplayConfig } from "./config";
import { peekValidSession } from "./session";

interface HistoryMessage {
  role: "user" | "assistant";
  content: string;
}

// A closed-and-reopened panel within the same page load already keeps its DOM as-is
// (see ui.ts -- the launcher just toggles .panel's hidden attribute). This is the
// other case: a fresh page load (navigation, reload) with a still-live session from
// earlier. Only ever reads a session that's already stored and unexpired -- a brand
// new visitor has no history to restore, so there's no reason to pay a session-start
// round trip just to confirm that.
async function restoreConversationOrGreet(apiBase: string, siteKey: string, widget: Widget, greetingMessage: string): Promise<void> {
  const session = peekValidSession(siteKey);
  if (session) {
    try {
      const response = await fetch(`${apiBase}/api/conversation-history`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (response.ok) {
        const { messages } = (await response.json()) as { messages: HistoryMessage[] };
        if (messages.length > 0) {
          for (const message of messages) widget.addMessage(message.role, message.content);
          return;
        }
      }
    } catch {
      // Best-effort -- fall through to the greeting below on any failure
      // (network error, expired-in-the-meantime session, etc.).
    }
  }
  if (greetingMessage.trim()) {
    widget.addMessage("assistant", greetingMessage);
  }
}

// document.currentScript is only valid during this script's own synchronous
// execution. The embed snippet uses `async`, so init() below may not run until
// DOMContentLoaded fires -- well after that window has closed -- which means
// re-reading document.currentScript from inside init() would silently get null.
// Capture it now, at the top level, before any deferral.
const scriptEl = document.currentScript as HTMLScriptElement | null;

async function init() {
  if (!scriptEl) return; // can't self-locate (e.g. dynamically injected without keeping a reference) -- nothing safe to do

  const siteKey = scriptEl.dataset.siteKey;
  if (!siteKey) {
    console.error("AutoChat 365 widget: data-site-key is required on the <script> tag.");
    return;
  }

  const apiBase = new URL(scriptEl.src).origin;
  // Position/color/title live on the widget's own settings now (see the dashboard's
  // Widgets section), not the embed snippet -- a tenant can change them without
  // touching their own site's HTML.
  const config = await fetchDisplayConfig(apiBase, siteKey);

  const widget = createWidget(config);
  await restoreConversationOrGreet(apiBase, siteKey, widget, config.greetingMessage);

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
