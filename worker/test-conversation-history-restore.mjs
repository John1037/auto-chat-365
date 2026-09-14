// Confirms a returning visitor sees their real conversation again on a fresh page
// load (not just a panel close/reopen within the same page, which already worked --
// see ui.ts, the launcher just toggles .panel's hidden attribute and never touches
// the DOM). Simulates "closed, then reopened within the same session" as two
// separate widget.js loads sharing the same localStorage state, the way a real
// browser would carry it across a page navigation or reload on the same site.
import { createClient } from "@supabase/supabase-js";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SERVICE_KEY = process.env.SUPABASE_SECRET_KEY;
const API_BASE = "http://127.0.0.1:8787";
const ORIGIN = "https://history-restore-test.example";

function assert(cond, msg) {
  if (!cond) throw new Error("ASSERTION FAILED: " + msg);
  console.log("  ok:", msg);
}

const widgetBundle = readFileSync(new URL("public/widget.js", import.meta.url), "utf8");

function loadWidget(siteKey, storedLocalStorage) {
  const dom = new JSDOM(
    `<!doctype html><html><body><script src="${API_BASE}/widget.js" data-site-key="${siteKey}"></script></body></html>`,
    { url: `${ORIGIN}/`, runScripts: "outside-only", resources: "usable" },
  );
  const { window } = dom;
  window.fetch = (url, init = {}) => fetch(url, { ...init, headers: { ...init.headers, Origin: ORIGIN } });
  // Real browsers keep localStorage across a page navigation/reload on the same
  // origin automatically; jsdom gives every new JSDOM instance a fresh one, so this
  // is the test's stand-in for "the visitor's browser already had this stored".
  if (storedLocalStorage) {
    for (const [key, value] of Object.entries(storedLocalStorage)) window.localStorage.setItem(key, value);
  }
  const scriptEl = window.document.querySelector("script");
  Object.defineProperty(window.document, "currentScript", { value: scriptEl, configurable: true });
  Object.defineProperty(window.document, "readyState", { value: "complete", configurable: true });
  window.eval(widgetBundle);
  return window;
}

function dumpLocalStorage(window) {
  const out = {};
  for (let i = 0; i < window.localStorage.length; i++) {
    const key = window.localStorage.key(i);
    out[key] = window.localStorage.getItem(key);
  }
  return out;
}

async function waitFor(check, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for: ${label}`);
}

async function main() {
  const service = createClient(SUPABASE_URL, SERVICE_KEY);
  const { data: tenant } = await service.from("tenants").insert({ name: "History Restore Test" }).select("id").single();
  const { data: widget } = await service
    .from("widgets")
    .insert({ tenant_id: tenant.id, allowed_origins: [ORIGIN], greeting_message: "Hi, how can we help?" })
    .select("id, site_key")
    .single();

  console.log("--- First load: fresh visitor sees only the greeting ---");
  const firstWindow = loadWidget(widget.site_key);
  await new Promise((r) => setTimeout(r, 1500)); // widget-config + (no session yet) init
  const firstShadow = firstWindow.document.getElementById("autochat365-widget-root").shadowRoot;
  const firstBubbles = () => [...firstShadow.querySelectorAll(".bubble")];
  assert(firstBubbles().length === 1 && firstBubbles()[0].classList.contains("assistant"), "only the greeting shows for a fresh visitor");

  console.log("--- Send a real message (mints a real session + conversation) ---");
  const input = firstShadow.querySelector(".input-row input");
  input.value = "Say the word pineapple and nothing else.";
  firstShadow.querySelector(".input-row").dispatchEvent(new firstWindow.Event("submit", { cancelable: true, bubbles: true }));
  await waitFor(() => firstBubbles().filter((b) => b.classList.contains("assistant")).length >= 2, 20000, "real chat reply");
  const sentUserText = firstShadow.querySelector(".bubble.user").textContent;
  const sentReplyText = [...firstShadow.querySelectorAll(".bubble.assistant")][1].textContent;
  console.log("  sent:", sentUserText);
  console.log("  reply:", sentReplyText);

  const storedState = dumpLocalStorage(firstWindow);
  const sessionKey = Object.keys(storedState).find((k) => k.startsWith("autochat365_session_"));
  assert(!!sessionKey, "a session was persisted to localStorage after the first real message");
  firstWindow.close();

  console.log("--- Second load (fresh page, same stored session): real history is restored, not the greeting ---");
  const secondWindow = loadWidget(widget.site_key, storedState);
  await new Promise((r) => setTimeout(r, 1500));
  const secondShadow = secondWindow.document.getElementById("autochat365-widget-root").shadowRoot;
  const secondBubbles = [...secondShadow.querySelectorAll(".bubble")];
  console.log(
    "  restored bubbles:",
    secondBubbles.map((b) => `${b.classList.contains("user") ? "user" : "assistant"}: ${b.textContent.slice(0, 40)}`),
  );
  assert(secondBubbles.length === 2, `exactly the two real messages are restored, no greeting re-added (got ${secondBubbles.length})`);
  assert(secondBubbles[0].classList.contains("user") && secondBubbles[0].textContent === sentUserText, "restored user message matches what was actually sent");
  assert(
    secondBubbles[1].classList.contains("assistant") && secondBubbles[1].textContent.includes(sentReplyText.replace(/\*\*/g, "")),
    "restored assistant message matches the real reply",
  );
  secondWindow.close();

  console.log("--- A third, brand-new visitor (no stored session) still sees only the greeting ---");
  const thirdWindow = loadWidget(widget.site_key);
  await new Promise((r) => setTimeout(r, 1500));
  const thirdShadow = thirdWindow.document.getElementById("autochat365-widget-root").shadowRoot;
  const thirdBubbles = [...thirdShadow.querySelectorAll(".bubble")];
  assert(thirdBubbles.length === 1 && thirdBubbles[0].classList.contains("assistant"), "a genuinely new visitor still gets the greeting, not someone else's history");
  thirdWindow.close();

  await service.from("tenants").delete().eq("id", tenant.id);
  console.log("\nALL CONVERSATION HISTORY RESTORE CHECKS PASSED");
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
