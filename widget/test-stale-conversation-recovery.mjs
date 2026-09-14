// Reproduces the exact production bug: a visitor's browser holds a valid-looking,
// unexpired stored session (from localStorage) whose conversation_id belongs to a
// session_id the server has already replaced (e.g. an earlier session that expired
// and was re-minted at some point, with the conversation_id wrongly carried
// forward -- the bug fixed in session.ts). Confirms the widget can still send a
// message successfully instead of showing "Something went wrong sending that
// message." on every send. Run against a live `wrangler dev` + local Supabase.
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const API_BASE = process.argv[2];
const SUPABASE_URL = process.argv[3] ?? "http://127.0.0.1:54321";
if (!API_BASE) {
  console.error("usage: node test-stale-conversation-recovery.mjs <apiBase> [supabaseUrl]");
  process.exit(1);
}

function assert(cond, msg) {
  if (!cond) throw new Error("ASSERTION FAILED: " + msg);
  console.log("  ok:", msg);
}

const ORIGIN = "https://stale-conv-widget-test.example";
const service = createClient(SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);

const { data: tenant } = await service.from("tenants").insert({ name: "Widget Stale Conversation Test" }).select("id").single();
const { data: widget } = await service
  .from("widgets")
  .insert({ tenant_id: tenant.id, allowed_origins: [ORIGIN] })
  .select("id, site_key")
  .single();

// Mint one real session/conversation the "normal" way, purely to get a real (but
// now-orphaned-from-this-new-session) conversation_id -- exactly what a visitor's
// browser would be holding after their original session expired and was replaced.
async function startSession() {
  const res = await fetch(`${API_BASE}/api/session-start`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({ site_key: widget.site_key }),
  });
  return res.json();
}
const staleSession = await startSession();
const chatRes = await fetch(`${API_BASE}/api/chat`, {
  method: "POST",
  headers: { Authorization: `Bearer ${staleSession.access_token}`, "Content-Type": "application/json", Origin: ORIGIN },
  body: JSON.stringify({ message: "original message from a session that will be replaced" }),
});
const { conversation_id: staleConversationId } = await chatRes.json();
console.log("stale conversation_id (belongs to a since-replaced session):", staleConversationId);

const bundle = readFileSync(new URL("../worker/public/widget.js", import.meta.url), "utf8");
const dom = new JSDOM(
  `<!doctype html><html><body><script src="${API_BASE}/widget.js" data-site-key="${widget.site_key}"></script></body></html>`,
  { url: `${ORIGIN}/`, runScripts: "outside-only", resources: "usable" },
);
const { window } = dom;
window.fetch = (url, init = {}) => fetch(url, { ...init, headers: { ...init.headers, Origin: ORIGIN } });

// Seed localStorage exactly like a real browser holding a still-"valid" (unexpired)
// stored session that nonetheless carries a stale conversation_id -- the state this
// bug produced before the fix. A far-future expires_at means getValidSession's normal
// reuse path (not the fresh-mint path) picks this up directly, so this specifically
// exercises what api.ts sends on the very next message, not the mint path itself.
window.localStorage.setItem(
  `autochat365_session_${widget.site_key}`,
  JSON.stringify({
    access_token: staleSession.access_token,
    refresh_token: staleSession.refresh_token,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    conversation_id: staleConversationId,
  }),
);

const scriptEl = window.document.querySelector("script");
Object.defineProperty(window.document, "currentScript", { value: scriptEl, configurable: true });
Object.defineProperty(window.document, "readyState", { value: "complete", configurable: true });
window.eval(bundle);
await new Promise((resolve) => setTimeout(resolve, 1500));

const shadow = window.document.getElementById("autochat365-widget-root").shadowRoot;
const input = shadow.querySelector("input");
const form = shadow.querySelector(".input-row");
input.value = "does this still work?";
form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));

await new Promise((resolve) => setTimeout(resolve, 3000));

const errorBanner = shadow.querySelector(".error-banner");
assert(errorBanner.hidden === true, `no error banner shown (got: "${errorBanner.textContent}")`);
const bubbles = [...shadow.querySelectorAll(".bubble")];
const lastBubble = bubbles[bubbles.length - 1];
assert(lastBubble.classList.contains("assistant"), "widget received and displayed a real assistant reply, not an error");

await service.from("tenants").delete().eq("id", tenant.id);
console.log("\nALL STALE-CONVERSATION RECOVERY CHECKS PASSED");
