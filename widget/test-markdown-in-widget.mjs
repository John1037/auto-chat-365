// End-to-end: drives the real built widget.js bundle in a real DOM, sends a message
// that reliably elicits markdown formatting from the real chat model, and confirms
// the rendered assistant bubble contains actual HTML elements (e.g. <strong>/<ul>)
// rather than literal asterisks -- proving the renderMarkdown() wiring in ui.ts
// actually fires along the real send path, not just in isolation. Run against a
// live `wrangler dev` + local Supabase.
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const API_BASE = process.argv[2];
const SUPABASE_URL = process.argv[3] ?? "http://127.0.0.1:54321";
if (!API_BASE) {
  console.error("usage: node test-markdown-in-widget.mjs <apiBase> [supabaseUrl]");
  process.exit(1);
}

function assert(cond, msg) {
  if (!cond) throw new Error("ASSERTION FAILED: " + msg);
  console.log("  ok:", msg);
}

const ORIGIN = "https://markdown-widget-test.example";
const service = createClient(SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);

const { data: tenant } = await service.from("tenants").insert({ name: "Markdown Widget Test" }).select("id").single();
const { data: widget } = await service
  .from("widgets")
  .insert({ tenant_id: tenant.id, allowed_origins: [ORIGIN] })
  .select("id, site_key")
  .single();

const bundle = readFileSync(new URL("../worker/public/widget.js", import.meta.url), "utf8");
const dom = new JSDOM(
  `<!doctype html><html><body><script src="${API_BASE}/widget.js" data-site-key="${widget.site_key}"></script></body></html>`,
  { url: `${ORIGIN}/`, runScripts: "outside-only", resources: "usable" },
);
const { window } = dom;
window.fetch = (url, init = {}) => fetch(url, { ...init, headers: { ...init.headers, Origin: ORIGIN } });

const scriptEl = window.document.querySelector("script");
Object.defineProperty(window.document, "currentScript", { value: scriptEl, configurable: true });
Object.defineProperty(window.document, "readyState", { value: "complete", configurable: true });
window.eval(bundle);
await new Promise((resolve) => setTimeout(resolve, 1500));

const shadow = window.document.getElementById("autochat365-widget-root").shadowRoot;
const input = shadow.querySelector("input");
const form = shadow.querySelector(".input-row");
input.value = "Reply with a short markdown example: one **bold** word and a bullet list of two items. Nothing else.";
form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));

await new Promise((resolve) => setTimeout(resolve, 25000));

const bubbles = [...shadow.querySelectorAll(".bubble")];
const assistantBubbles = bubbles.filter((b) => b.classList.contains("assistant"));
const reply = assistantBubbles[assistantBubbles.length - 1];
console.log("  rendered assistant bubble innerHTML:", reply.innerHTML);

const errorBanner = shadow.querySelector(".error-banner");
assert(errorBanner.hidden === true, `no error banner shown (got: "${errorBanner.textContent}")`);
assert(reply.querySelector("strong, ul, li, em, code") !== null, "reply contains at least one real markdown element, not literal symbols");
assert(!reply.textContent.includes("**"), "no literal ** survives in the displayed text");

await service.from("tenants").delete().eq("id", tenant.id);
console.log("\nALL WIDGET MARKDOWN RENDERING CHECKS PASSED");
