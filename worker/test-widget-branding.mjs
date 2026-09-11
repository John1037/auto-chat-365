// Verifies the new widget branding settings (header logo, header background color)
// and the fixed "Powered by 365 Applications" footer line, by running the actual
// built widget.js bundle in a real DOM against a real widget-config response --
// same eval-based technique as test-runtime-config.mjs.
import { createClient } from "@supabase/supabase-js";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SERVICE_KEY = process.env.SUPABASE_SECRET_KEY;
const ANON_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;
const API_BASE = "http://127.0.0.1:8787";

function assert(cond, msg) {
  if (!cond) throw new Error("ASSERTION FAILED: " + msg);
  console.log("  ok:", msg);
}

async function main() {
  const admin = createClient(SUPABASE_URL, SERVICE_KEY);
  const email = `branding-test-${Date.now()}@example.test`;
  const password = "test-password-123!";
  const { data: created, error: createErr } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (createErr) throw createErr;

  const anon = createClient(SUPABASE_URL, ANON_KEY);
  const { data: signIn, error: signInErr } = await anon.auth.signInWithPassword({ email, password });
  if (signInErr) throw signInErr;
  const accessToken = signIn.session.access_token;

  console.log("--- Provision tenant + widget, set branding via RLS-scoped update (same path the settings page uses) ---");
  await fetch(`${API_BASE}/api/tenant-provision`, { method: "POST", headers: { Authorization: `Bearer ${accessToken}` } });
  const { widget } = await (
    await fetch(`${API_BASE}/api/create-widget`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Branding Test Widget" }),
    })
  ).json();

  const logoUrl = "https://example.test/logo.png";
  const headerColor = "#22334a";
  const { error: updateError } = await anon
    .from("widgets")
    .update({ logo_url: logoUrl, header_color: headerColor, allowed_origins: ["https://branding-test.example"] })
    .eq("id", widget.id);
  if (updateError) throw updateError;

  console.log("--- /api/widget-config returns the new fields ---");
  const cfgRes = await fetch(`${API_BASE}/api/widget-config?site_key=${widget.site_key}`, {
    headers: { Origin: "https://branding-test.example" },
  });
  const cfg = await cfgRes.json();
  console.log("  config:", cfg);
  assert(cfg.logo_url === logoUrl, "logo_url round-tripped");
  assert(cfg.header_color === headerColor, "header_color round-tripped");

  console.log("--- Real widget.js bundle renders the branding + footer line ---");
  const dom = new JSDOM(
    `<!doctype html><html><body><script src="${API_BASE}/widget.js" data-site-key="${widget.site_key}"></script></body></html>`,
    { url: "https://branding-test.example/", runScripts: "outside-only", resources: "usable" },
  );
  const { window } = dom;
  window.fetch = (url, init = {}) =>
    fetch(url, { ...init, headers: { ...init.headers, Origin: "https://branding-test.example" } });
  const scriptEl = window.document.querySelector("script");
  Object.defineProperty(window.document, "currentScript", { value: scriptEl, configurable: true });
  Object.defineProperty(window.document, "readyState", { value: "complete", configurable: true });
  window.eval(readFileSync(new URL("public/widget.js", import.meta.url), "utf8"));

  await new Promise((r) => setTimeout(r, 1500));

  const shadow = window.document.getElementById("autochat365-widget-root").shadowRoot;
  const styleText = shadow.querySelector("style").textContent;
  assert(styleText.includes(`background: ${headerColor};`), "panel-header CSS uses the fetched header_color");

  const logoImg = shadow.querySelector(".panel-logo");
  assert(!!logoImg, "a .panel-logo <img> was rendered (tenant logo replaces the default mark)");
  assert(logoImg.getAttribute("src") === logoUrl, "logo <img> src is the configured logo_url");
  assert(!shadow.querySelector(".panel-header svg"), "default LOGO_SVG is NOT rendered when a logo_url is set");

  const poweredBy = shadow.querySelector(".powered-by");
  assert(!!poweredBy, ".powered-by element exists");
  assert(poweredBy.textContent === "Powered by 365 Applications", "footer text is exactly right");

  const panelChildren = Array.from(shadow.querySelector(".panel").children).map((el) => el.className);
  const poweredByIndex = panelChildren.indexOf("powered-by");
  const inputRowIndex = panelChildren.findIndex((c) => c.includes("input-row"));
  console.log("  panel children order:", panelChildren);
  assert(poweredByIndex >= 0 && inputRowIndex >= 0 && poweredByIndex === inputRowIndex - 1, "powered-by sits immediately above the input row's divider");

  console.log("--- widget-settings.html form loads and can re-save the new fields ---");
  const settingsHtml = await (await fetch(`${API_BASE}/widget-settings.html`)).text();
  // No real browser navigation happened here, so fake the same hash a magic-link
  // redirect would leave -- supabase-js's detectSessionInUrl picks tokens up from
  // location.hash on client creation regardless of how they got there.
  const authHash =
    `access_token=${signIn.session.access_token}&refresh_token=${signIn.session.refresh_token}` +
    `&expires_in=3600&token_type=bearer&type=magiclink`;
  const settingsDom = new JSDOM(settingsHtml, {
    url: `${API_BASE}/widget-settings.html?id=${widget.id}#${authHash}`,
    runScripts: "outside-only",
    resources: "usable",
  });
  const settingsWindow = settingsDom.window;
  settingsWindow.fetch = (url, init) => fetch(new URL(url, API_BASE), init);
  settingsWindow.eval(readFileSync(new URL("public/widget-settings.js", import.meta.url), "utf8"));

  await new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (settingsWindow.document.querySelector("#content")?.hidden === false) return resolve();
      if (Date.now() - start > 10000) return reject(new Error("timed out waiting for settings form to load"));
      setTimeout(check, 200);
    };
    check();
  });

  const logoField = settingsWindow.document.querySelector("#logo-url-input").value;
  const headerColorField = settingsWindow.document.querySelector("#header-color-input").value;
  console.log("  form fields:", { logoField, headerColorField });
  assert(logoField === logoUrl, "settings form's logo URL field is pre-filled correctly");
  assert(headerColorField.toLowerCase() === headerColor.toLowerCase(), "settings form's header color field is pre-filled correctly");

  console.log("\nALL BRANDING CHECKS PASSED");
  window.close();
  settingsWindow.close();
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
