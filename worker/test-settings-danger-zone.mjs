// Confirms the dashboard's settings.html page: the Danger Zone only renders for an
// owner/admin (never for someone with no tenant membership at all), the delete
// button stays disabled until the exact confirmation phrase is typed, and a real
// deletion via the real UI flow actually removes the tenant. Same jsdom-driven
// technique as the other dashboard-page tests.
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

async function loadSettingsPage(email, password) {
  const anon = createClient(SUPABASE_URL, ANON_KEY);
  const { data: signIn } = await anon.auth.signInWithPassword({ email, password });
  const authHash =
    `access_token=${signIn.session.access_token}&refresh_token=${signIn.session.refresh_token}` +
    `&expires_in=3600&token_type=bearer&type=magiclink`;
  const settingsHtml = await (await fetch(`${API_BASE}/settings.html`)).text();
  const dom = new JSDOM(settingsHtml, {
    url: `${API_BASE}/settings.html#${authHash}`,
    runScripts: "outside-only",
    resources: "usable",
  });
  const { window } = dom;
  window.fetch = (url, init) => fetch(new URL(url, API_BASE), init);
  window.eval(readFileSync(new URL("public/settings.js", import.meta.url), "utf8"));
  await new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (window.document.querySelector("#sign-out")) return resolve(); // page finished its main() enough to have wired basics
      if (Date.now() - start > 10000) return reject(new Error("timed out waiting for settings page to load"));
      setTimeout(check, 200);
    };
    check();
  });
  await new Promise((r) => setTimeout(r, 500)); // let the async role check + dangerZone.hidden toggle settle
  return { window, signIn };
}

async function main() {
  const service = createClient(SUPABASE_URL, SERVICE_KEY);
  const password = "test-password-123!";

  console.log("--- A real owner sees the Danger Zone ---");
  const ownerEmail = `danger-zone-owner-${Date.now()}@example.test`;
  await service.auth.admin.createUser({ email: ownerEmail, password, email_confirm: true });
  let tenantId;
  {
    const anon = createClient(SUPABASE_URL, ANON_KEY);
    const { data: signIn } = await anon.auth.signInWithPassword({ email: ownerEmail, password });
    const provisionRes = await fetch(`${API_BASE}/api/tenant-provision`, { method: "POST", headers: { Authorization: `Bearer ${signIn.session.access_token}` } });
    const { tenant } = await provisionRes.json();
    tenantId = tenant.id;
  }
  const { window: ownerWindow } = await loadSettingsPage(ownerEmail, password);
  const dangerZone = ownerWindow.document.querySelector("#danger-zone");
  assert(dangerZone.hidden === false, "Danger Zone is visible for a real tenant owner");

  console.log("--- Delete button stays disabled until the exact phrase is typed ---");
  const confirmInput = ownerWindow.document.querySelector("#delete-confirm-input");
  const deleteButton = ownerWindow.document.querySelector("#delete-account-button");
  assert(deleteButton.disabled === true, "delete button starts disabled");

  confirmInput.value = "delete account"; // wrong case
  confirmInput.dispatchEvent(new ownerWindow.Event("input", { bubbles: true }));
  assert(deleteButton.disabled === true, "still disabled for a near-miss (wrong case)");

  confirmInput.value = "DELETE ACCOUN"; // missing final T
  confirmInput.dispatchEvent(new ownerWindow.Event("input", { bubbles: true }));
  assert(deleteButton.disabled === true, "still disabled for an incomplete phrase");

  confirmInput.value = "DELETE ACCOUNT";
  confirmInput.dispatchEvent(new ownerWindow.Event("input", { bubbles: true }));
  assert(deleteButton.disabled === false, "enabled once the exact phrase is typed");

  console.log("--- Clicking through actually deletes the account ---");
  deleteButton.dispatchEvent(new ownerWindow.Event("click", { bubbles: true }));
  await new Promise((resolve, reject) => {
    const start = Date.now();
    const check = async () => {
      const { data } = await service.from("tenants").select("id").eq("id", tenantId).maybeSingle();
      if (data === null) return resolve();
      if (Date.now() - start > 10000) return reject(new Error("timed out waiting for tenant to actually be deleted"));
      setTimeout(check, 200);
    };
    check();
  });
  console.log("  ok: tenant row confirmed gone from the DB after clicking through the real UI flow");
  ownerWindow.close();

  console.log("--- A user with no tenant membership never sees the Danger Zone ---");
  const outsiderEmail = `danger-zone-outsider-${Date.now()}@example.test`;
  await service.auth.admin.createUser({ email: outsiderEmail, password, email_confirm: true });
  const { window: outsiderWindow } = await loadSettingsPage(outsiderEmail, password);
  assert(outsiderWindow.document.querySelector("#danger-zone").hidden === true, "Danger Zone stays hidden for a user with no tenant at all");
  outsiderWindow.close();

  console.log("\nALL SETTINGS DANGER-ZONE CHECKS PASSED");
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
