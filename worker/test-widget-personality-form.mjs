// Confirms the dashboard's widget-settings.html form actually loads and saves the
// new Personality section's three <select> fields (same technique as
// test-widget-theme-settings-form.mjs).
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
  const email = `personality-form-test-${Date.now()}@example.test`;
  const password = "test-password-123!";
  const { data: created, error: createErr } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (createErr) throw createErr;

  const anon = createClient(SUPABASE_URL, ANON_KEY);
  const { data: signIn } = await anon.auth.signInWithPassword({ email, password });
  const accessToken = signIn.session.access_token;

  await fetch(`${API_BASE}/api/tenant-provision`, { method: "POST", headers: { Authorization: `Bearer ${accessToken}` } });
  const { widget } = await (
    await fetch(`${API_BASE}/api/create-widget`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Personality Form Test" }),
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

  // Fieldset is positioned between Identity and Appearance in the DOM.
  const legends = [...window.document.querySelectorAll(".settings-section legend")].map((l) => l.textContent);
  assert(
    legends.indexOf("Identity") < legends.indexOf("Personality") && legends.indexOf("Personality") < legends.indexOf("Appearance"),
    `Personality section sits between Identity and Appearance (got order: ${legends.join(", ")})`,
  );

  const characterStyleSelect = window.document.querySelector("#character-style-input");
  const responseStyleSelect = window.document.querySelector("#response-style-input");
  const responseLengthSelect = window.document.querySelector("#response-length-input");
  assert(characterStyleSelect.value === "helpful", `default character_style shows 'helpful' (got '${characterStyleSelect.value}')`);
  assert(responseStyleSelect.value === "balanced", `default response_style shows 'balanced' (got '${responseStyleSelect.value}')`);
  assert(responseLengthSelect.value === "normal", `default response_length shows 'normal' (got '${responseLengthSelect.value}')`);

  characterStyleSelect.value = "cheerful";
  responseStyleSelect.value = "non-technical";
  responseLengthSelect.value = "concise";
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

  const service = createClient(SUPABASE_URL, SERVICE_KEY);
  const { data: row } = await service
    .from("widgets")
    .select("character_style, response_style, response_length")
    .eq("id", widget.id)
    .maybeSingle();
  assert(row.character_style === "cheerful", `saved character_style persisted (got '${row.character_style}')`);
  assert(row.response_style === "non-technical", `saved response_style persisted (got '${row.response_style}')`);
  assert(row.response_length === "concise", `saved response_length persisted (got '${row.response_length}')`);

  console.log("\nALL PERSONALITY SETTINGS FORM CHECKS PASSED");
  window.close();
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
