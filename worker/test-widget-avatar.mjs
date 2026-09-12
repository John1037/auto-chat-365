// Verifies the widget avatar + chatbot name "sender row" feature: it only appears
// when BOTH are set, appears above every assistant message (greeting AND a real
// chat reply), and never above the visitor's own messages. Also covers the
// upload-widget-avatar route itself (auth, ownership, validation) same as logo.
import { createClient } from "@supabase/supabase-js";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SERVICE_KEY = process.env.SUPABASE_SECRET_KEY;
const ANON_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;
const API_BASE = "http://127.0.0.1:8787";
const ORIGIN = "https://avatar-test.example";

function assert(cond, msg) {
  if (!cond) throw new Error("ASSERTION FAILED: " + msg);
  console.log("  ok:", msg);
}

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

async function renderAndInspect(siteKey) {
  const dom = new JSDOM(
    `<!doctype html><html><body><script src="${API_BASE}/widget.js" data-site-key="${siteKey}"></script></body></html>`,
    { url: `${ORIGIN}/`, runScripts: "outside-only", resources: "usable" },
  );
  const { window } = dom;
  window.fetch = (url, init = {}) => fetch(url, { ...init, headers: { ...init.headers, Origin: ORIGIN } });
  const scriptEl = window.document.querySelector("script");
  Object.defineProperty(window.document, "currentScript", { value: scriptEl, configurable: true });
  Object.defineProperty(window.document, "readyState", { value: "complete", configurable: true });
  window.eval(readFileSync(new URL("public/widget.js", import.meta.url), "utf8"));
  await new Promise((r) => setTimeout(r, 1200));
  return { window, shadow: window.document.getElementById("autochat365-widget-root").shadowRoot };
}

async function main() {
  const service = createClient(SUPABASE_URL, SERVICE_KEY);
  const admin = createClient(SUPABASE_URL, SERVICE_KEY);
  const email = `avatar-test-a-${Date.now()}@example.test`;
  const password = "test-password-123!";
  await admin.auth.admin.createUser({ email, password, email_confirm: true });
  const anon = createClient(SUPABASE_URL, ANON_KEY);
  const { data: signIn } = await anon.auth.signInWithPassword({ email, password });
  const accessToken = signIn.session.access_token;

  await fetch(`${API_BASE}/api/tenant-provision`, { method: "POST", headers: { Authorization: `Bearer ${accessToken}` } });
  const { widget } = await (
    await fetch(`${API_BASE}/api/create-widget`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Avatar Test Widget" }),
    })
  ).json();
  await service.from("widgets").update({ allowed_origins: [ORIGIN] }).eq("id", widget.id);

  console.log("--- Upload avatar route: validation + ownership (same as logo route) ---");
  const pngBytes = Buffer.from(TINY_PNG_BASE64, "base64");
  const form = new FormData();
  form.append("widget_id", widget.id);
  form.append("file", new Blob([pngBytes], { type: "image/png" }), "avatar.png");
  const uploadRes = await fetch(`${API_BASE}/api/upload-widget-avatar`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
    body: form,
  });
  assert(uploadRes.ok, `avatar upload succeeded (${uploadRes.status})`);
  const { avatar_url: avatarUrl } = await uploadRes.json();
  console.log("  avatar_url:", avatarUrl);
  assert(avatarUrl.includes("/widget-logos/") && avatarUrl.includes("/avatar"), "avatar stored at a distinct path from the logo");

  const wrongType = new FormData();
  wrongType.append("widget_id", widget.id);
  wrongType.append("file", new Blob(["nope"], { type: "text/plain" }));
  const wrongTypeRes = await fetch(`${API_BASE}/api/upload-widget-avatar`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
    body: wrongType,
  });
  assert(wrongTypeRes.status === 400, `disallowed mime type rejected (${wrongTypeRes.status})`);

  console.log("--- No sender row when neither avatar nor chatbot_name is set ---");
  await service.from("widgets").update({ avatar_url: null, chatbot_name: null }).eq("id", widget.id);
  let { shadow } = await renderAndInspect(widget.site_key);
  assert(shadow.querySelectorAll(".sender-row").length === 0, "greeting bubble has no sender row by default");

  console.log("--- No sender row when only chatbot_name is set (no avatar) ---");
  await service.from("widgets").update({ chatbot_name: "Ada" }).eq("id", widget.id);
  ({ shadow } = await renderAndInspect(widget.site_key));
  assert(shadow.querySelectorAll(".sender-row").length === 0, "name alone does not trigger the sender row");

  console.log("--- No sender row when only avatar is set (no chatbot_name) ---");
  await service.from("widgets").update({ chatbot_name: null, avatar_url: avatarUrl }).eq("id", widget.id);
  ({ shadow } = await renderAndInspect(widget.site_key));
  assert(shadow.querySelectorAll(".sender-row").length === 0, "avatar alone does not trigger the sender row");

  console.log("--- Sender row appears when BOTH are set (greeting + a real chat reply) ---");
  await service.from("widgets").update({ chatbot_name: "Ada" }).eq("id", widget.id);
  const { window, shadow: shadowBoth } = await renderAndInspect(widget.site_key);

  const greetingSender = shadowBoth.querySelector(".sender-row");
  assert(!!greetingSender, "sender row present above the greeting once both fields are set");
  assert(greetingSender.querySelector(".sender-avatar").getAttribute("src") === avatarUrl, "sender row avatar src is correct");
  assert(greetingSender.querySelector(".sender-name").textContent === "Ada", "sender row name is correct");
  assert(greetingSender.nextElementSibling.classList.contains("bubble"), "sender row sits directly above its bubble");

  // Real send round trip through the actual chat backend.
  const input = shadowBoth.querySelector(".input-row input");
  input.value = "Say the word banana and nothing else.";
  shadowBoth.querySelector(".input-row").dispatchEvent(new window.Event("submit", { cancelable: true, bubbles: true }));

  await new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      const bubbles = shadowBoth.querySelectorAll(".bubble.assistant");
      if (bubbles.length >= 2) return resolve(); // greeting + real reply
      if (Date.now() - start > 20000) return reject(new Error("timed out waiting for chat reply"));
      setTimeout(check, 300);
    };
    check();
  });

  const senderRows = shadowBoth.querySelectorAll(".sender-row");
  const assistantBubbles = shadowBoth.querySelectorAll(".bubble.assistant");
  const userBubbles = shadowBoth.querySelectorAll(".bubble.user");
  console.log(
    "  sender rows:",
    senderRows.length,
    "assistant bubbles:",
    assistantBubbles.length,
    "user bubbles:",
    userBubbles.length,
  );
  assert(senderRows.length === assistantBubbles.length, "every assistant bubble (greeting + real reply) got its own sender row");
  assert(userBubbles.length === 1, "the visitor's own message rendered normally");

  // Confirm no sender-row got attached to (or right before) the user's own bubble.
  const userBubble = shadowBoth.querySelector(".bubble.user");
  assert(!userBubble.previousElementSibling.classList.contains("sender-row"), "no sender row precedes the visitor's own message");

  window.close();
  await service.from("tenants").delete().eq("id", (await service.from("widgets").select("tenant_id").eq("id", widget.id).single()).data.tenant_id);

  console.log("\nALL AVATAR/SENDER-ROW CHECKS PASSED");
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
