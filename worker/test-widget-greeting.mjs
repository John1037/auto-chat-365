// Verifies the optional per-widget greeting bubble: default text, a custom override,
// and that clearing it disables the greeting entirely -- checked against the real
// built widget.js bundle in a real DOM, same eval-based technique used throughout.
import { createClient } from "@supabase/supabase-js";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SERVICE_KEY = process.env.SUPABASE_SECRET_KEY;
const API_BASE = "http://127.0.0.1:8787";
const ORIGIN = "https://greeting-test.example";

function assert(cond, msg) {
  if (!cond) throw new Error("ASSERTION FAILED: " + msg);
  console.log("  ok:", msg);
}

async function firstBubbleText(siteKey) {
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
  const shadow = window.document.getElementById("autochat365-widget-root").shadowRoot;
  const bubbles = [...shadow.querySelectorAll(".messages .bubble")];
  const result = bubbles.length > 0 ? bubbles[0].textContent : null;
  window.close();
  return { text: result, count: bubbles.length };
}

async function main() {
  const service = createClient(SUPABASE_URL, SERVICE_KEY);
  const { data: tenant } = await service.from("tenants").insert({ name: "Greeting Test Co" }).select("id").single();
  const { data: widget } = await service
    .from("widgets")
    .insert({ tenant_id: tenant.id, allowed_origins: [ORIGIN] })
    .select("id, site_key")
    .single();

  console.log("--- Default greeting ---");
  const cfg = await (await fetch(`${API_BASE}/api/widget-config?site_key=${widget.site_key}`, { headers: { Origin: ORIGIN } })).json();
  assert(cfg.greeting_message === "Hi, how can we help?", `widget-config returns the default greeting (got "${cfg.greeting_message}")`);

  const defaultRender = await firstBubbleText(widget.site_key);
  assert(defaultRender.count === 1, `exactly one bubble shown before any interaction (got ${defaultRender.count})`);
  assert(defaultRender.text === "Hi, how can we help?", `default greeting bubble text is correct (got "${defaultRender.text}")`);

  console.log("--- Custom greeting ---");
  await service.from("widgets").update({ greeting_message: "Welcome to Greeting Test Co!" }).eq("id", widget.id);
  const customRender = await firstBubbleText(widget.site_key);
  assert(customRender.text === "Welcome to Greeting Test Co!", `custom greeting renders correctly (got "${customRender.text}")`);

  console.log("--- Cleared greeting (disabled) ---");
  await service.from("widgets").update({ greeting_message: "" }).eq("id", widget.id);
  const clearedRender = await firstBubbleText(widget.site_key);
  assert(clearedRender.count === 0, `no greeting bubble rendered when cleared (got ${clearedRender.count} bubbles)`);

  await service.from("tenants").delete().eq("id", tenant.id);

  console.log("\nALL GREETING CHECKS PASSED");
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
