// Confirms the dashboard's widget-settings.html form actually loads and saves the
// two new size sliders, and that their live "+N%" readouts update as the slider
// moves -- same technique as test-widget-theme-settings-form.mjs.
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
  const email = `size-form-test-${Date.now()}@example.test`;
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
      body: JSON.stringify({ name: "Size Form Test" }),
    })
  ).json();

  const authHash =
    `access_token=${signIn.session.access_token}&refresh_token=${signIn.session.refresh_token}` +
    `&expires_in=3600&token_type=bearer&type=magiclink`;
  const settingsHtml = await (await fetch(`${API_BASE}/widget-settings.html`)).text();
  const dom = new JSDOM(settingsHtml, {
    url: `${API_BASE}/widget-settings.html?id=${widget.id}#${authHash}`,
    runScripts: "outside-only",
    resources: "usable",
  });
  const { window } = dom;
  window.fetch = (url, init) => fetch(new URL(url, API_BASE), init);
  window.eval(readFileSync(new URL("public/widget-settings.js", import.meta.url), "utf8"));

  await new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (window.document.querySelector("#content")?.hidden === false) return resolve();
      if (Date.now() - start > 10000) return reject(new Error("timed out waiting for settings form"));
      setTimeout(check, 200);
    };
    check();
  });

  console.log("--- Defaults: both sliders at 0, readouts show +0% ---");
  const iconSlider = window.document.querySelector("#icon-size-input");
  const iconReadout = window.document.querySelector("#icon-size-readout");
  const windowSlider = window.document.querySelector("#window-size-input");
  const windowReadout = window.document.querySelector("#window-size-readout");
  assert(iconSlider.value === "0", `icon slider defaults to 0 (got '${iconSlider.value}')`);
  assert(iconReadout.textContent === "+0%", `icon readout shows +0% (got '${iconReadout.textContent}')`);
  assert(windowSlider.value === "0", `window slider defaults to 0 (got '${windowSlider.value}')`);
  assert(windowReadout.textContent === "+0%", `window readout shows +0% (got '${windowReadout.textContent}')`);

  console.log("--- Moving a slider live-updates its own readout, without touching the other ---");
  iconSlider.value = "60";
  iconSlider.dispatchEvent(new window.Event("input", { bubbles: true }));
  assert(iconReadout.textContent === "+60%", `icon readout updates live to +60% (got '${iconReadout.textContent}')`);
  assert(windowReadout.textContent === "+0%", "window readout is untouched by the icon slider moving");

  console.log("--- Saving persists both independent values to the DB ---");
  windowSlider.value = "35";
  windowSlider.dispatchEvent(new window.Event("input", { bubbles: true }));
  window.document.querySelector("#settings-form").dispatchEvent(new window.Event("submit", { cancelable: true, bubbles: true }));

  await new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (window.document.querySelector("#save-status")?.textContent === "Saved.") return resolve();
      if (Date.now() - start > 10000) return reject(new Error("timed out waiting for save"));
      setTimeout(check, 200);
    };
    check();
  });

  const { data: row } = await admin.from("widgets").select("icon_scale_pct, window_scale_pct").eq("id", widget.id).maybeSingle();
  assert(row.icon_scale_pct === 60, `saved icon_scale_pct persisted (got ${row.icon_scale_pct})`);
  assert(row.window_scale_pct === 35, `saved window_scale_pct persisted (got ${row.window_scale_pct})`);

  console.log("\nALL WIDGET SIZE SETTINGS FORM CHECKS PASSED");
  window.close();
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
