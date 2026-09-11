// Verifies the new widget theme setting: explicit "light"/"dark" render the right
// palette, and "auto" resolves via prefers-color-scheme (matchMedia) at init time --
// same eval-based real-bundle technique as test-widget-branding.mjs. jsdom doesn't
// implement matchMedia, so it's stubbed here the same way a real browser's
// implementation would answer.
import { createClient } from "@supabase/supabase-js";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SERVICE_KEY = process.env.SUPABASE_SECRET_KEY;
const API_BASE = "http://127.0.0.1:8787";
const ORIGIN = "https://theme-test.example";

function assert(cond, msg) {
  if (!cond) throw new Error("ASSERTION FAILED: " + msg);
  console.log("  ok:", msg);
}

async function renderWithTheme(siteKey, prefersDark) {
  const dom = new JSDOM(
    `<!doctype html><html><body><script src="${API_BASE}/widget.js" data-site-key="${siteKey}"></script></body></html>`,
    { url: `${ORIGIN}/`, runScripts: "outside-only", resources: "usable" },
  );
  const { window } = dom;
  window.fetch = (url, init = {}) => fetch(url, { ...init, headers: { ...init.headers, Origin: ORIGIN } });
  window.matchMedia = (query) => ({
    matches: query === "(prefers-color-scheme: dark)" ? prefersDark : false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  });
  const scriptEl = window.document.querySelector("script");
  Object.defineProperty(window.document, "currentScript", { value: scriptEl, configurable: true });
  Object.defineProperty(window.document, "readyState", { value: "complete", configurable: true });
  window.eval(readFileSync(new URL("public/widget.js", import.meta.url), "utf8"));
  await new Promise((r) => setTimeout(r, 1200));
  const styleText = window.document.getElementById("autochat365-widget-root").shadowRoot.querySelector("style").textContent;
  window.close();
  return styleText;
}

async function main() {
  const service = createClient(SUPABASE_URL, SERVICE_KEY);
  const { data: tenant } = await service.from("tenants").insert({ name: "Theme Test Co" }).select("id").single();
  const { data: widget } = await service
    .from("widgets")
    .insert({ tenant_id: tenant.id, allowed_origins: [ORIGIN] })
    .select("id, site_key")
    .single();

  console.log("--- Explicit dark ---");
  await service.from("widgets").update({ theme: "dark" }).eq("id", widget.id);
  const darkCss = await renderWithTheme(widget.site_key, false);
  assert(darkCss.includes("background: #0e1213;"), "explicit dark theme renders the dark panel background");
  assert(darkCss.includes("color: #eef2f2;"), "explicit dark theme renders dark-theme text color");

  console.log("--- Explicit light ---");
  await service.from("widgets").update({ theme: "light" }).eq("id", widget.id);
  const lightCss = await renderWithTheme(widget.site_key, true); // even with OS prefers dark, explicit wins
  assert(lightCss.includes("background: #ffffff;"), "explicit light theme renders the light panel background");
  assert(lightCss.includes("color: #14181a;"), "explicit light theme renders light-theme text color");

  console.log("--- Auto, OS prefers dark ---");
  await service.from("widgets").update({ theme: "auto" }).eq("id", widget.id);
  const autoDarkCss = await renderWithTheme(widget.site_key, true);
  assert(autoDarkCss.includes("background: #0e1213;"), "auto + OS dark resolves to dark palette");

  console.log("--- Auto, OS prefers light ---");
  const autoLightCss = await renderWithTheme(widget.site_key, false);
  assert(autoLightCss.includes("background: #ffffff;"), "auto + OS light resolves to light palette");

  await service.from("tenants").delete().eq("id", tenant.id);

  console.log("\nALL THEME CHECKS PASSED");
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
