// Verifies the widget-settings.html redesign: fieldset/legend grouping, and that
// the upload/remove buttons for logo and avatar are mutually exclusive (only one
// visible at a time, matching the state of the image itself) -- checked against the
// real page + real built bundle via a real signed-in session.
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

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

async function main() {
  const admin = createClient(SUPABASE_URL, SERVICE_KEY);
  const email = `layout-test-${Date.now()}@example.test`;
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
      body: JSON.stringify({ name: "Layout Test Widget" }),
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
  window.fetch = async (url, init) => {
    let realInit = init;
    if (init?.body && typeof init.body.entries === "function") {
      const realForm = new FormData();
      for (const [key, value] of init.body.entries()) {
        if (value && typeof value.arrayBuffer === "function") {
          realForm.append(key, new File([await value.arrayBuffer()], value.name, { type: value.type }));
        } else {
          realForm.append(key, value);
        }
      }
      realInit = { ...init, body: realForm };
    }
    return fetch(new URL(url, API_BASE), realInit);
  };
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

  console.log("--- Structure: fieldset/legend grouping ---");
  const fieldsets = [...window.document.querySelectorAll(".settings-section")];
  const legends = fieldsets.map((f) => f.querySelector("legend")?.textContent);
  console.log("  sections:", legends);
  assert(JSON.stringify(legends) === JSON.stringify(["Identity", "Appearance", "Access"]), "three sections in the expected order");

  const identityIds = [...fieldsets[0].querySelectorAll("input, select, textarea")].map((el) => el.id);
  assert(identityIds.includes("name-input"), "Identity contains widget name");
  assert(identityIds.includes("chatbot-name-input"), "Identity contains chatbot name");
  assert(identityIds.includes("avatar-file-input"), "Identity contains the avatar upload control");
  assert(identityIds.includes("chat-title-input"), "Identity contains chat title");
  assert(identityIds.includes("greeting-input"), "Identity contains the greeting message");

  const appearanceIds = [...fieldsets[1].querySelectorAll("input, select, textarea")].map((el) => el.id);
  assert(appearanceIds.includes("logo-file-input"), "Appearance contains the header logo upload control");
  assert(appearanceIds.includes("color-input"), "Appearance contains color scheme");
  assert(appearanceIds.includes("header-color-input"), "Appearance contains top bar background");
  assert(appearanceIds.includes("theme-input"), "Appearance contains the theme selector");
  assert(appearanceIds.includes("position-input"), "Appearance contains position");

  const accessIds = [...fieldsets[2].querySelectorAll("input, select, textarea")].map((el) => el.id);
  assert(JSON.stringify(accessIds) === JSON.stringify(["origins-input"]), "Access contains only allowed origins");

  console.log("--- Accessibility: aria-live on async status regions ---");
  for (const id of ["#save-status", "#logo-status", "#avatar-status", "#loading", "#error"]) {
    const el = window.document.querySelector(id);
    assert(el.getAttribute("aria-live") === "polite", `${id} has aria-live="polite"`);
  }
  assert(
    window.document.querySelector("#avatar-upload-button").getAttribute("aria-label") === "Upload chatbot avatar image",
    "avatar upload button has a distinct accessible name",
  );
  assert(
    window.document.querySelector("#logo-remove-button").getAttribute("aria-label") === "Remove header logo",
    "logo remove button has a distinct accessible name",
  );

  console.log("--- Only one button per upload control is visible at a time ---");
  const logoUpload = window.document.querySelector("#logo-upload-button");
  const logoRemove = window.document.querySelector("#logo-remove-button");
  const avatarUpload = window.document.querySelector("#avatar-upload-button");
  const avatarRemove = window.document.querySelector("#avatar-remove-button");

  assert(logoUpload.hidden === false && logoRemove.hidden === true, "no logo yet: only Upload shown");
  assert(avatarUpload.hidden === false && avatarRemove.hidden === true, "no avatar yet: only Upload shown");

  const pngBytes = Buffer.from(TINY_PNG_BASE64, "base64");
  const file = new window.File([pngBytes], "logo.png", { type: "image/png" });
  Object.defineProperty(window.document.querySelector("#logo-file-input"), "files", { value: [file], configurable: true });
  window.document.querySelector("#logo-file-input").dispatchEvent(new window.Event("change", { bubbles: true }));

  await new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (window.document.querySelector("#logo-status")?.textContent === "Updated.") return resolve();
      if (Date.now() - start > 10000) return reject(new Error("timed out waiting for logo upload"));
      setTimeout(check, 200);
    };
    check();
  });

  assert(logoUpload.hidden === true && logoRemove.hidden === false, "after uploading a logo: only Remove shown");
  assert(avatarUpload.hidden === false && avatarRemove.hidden === true, "avatar control untouched by the logo upload");

  logoRemove.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (window.document.querySelector("#logo-status")?.textContent === "Removed.") return resolve();
      if (Date.now() - start > 10000) return reject(new Error("timed out waiting for logo removal"));
      setTimeout(check, 200);
    };
    check();
  });
  assert(logoUpload.hidden === false && logoRemove.hidden === true, "after removing: back to only Upload shown");

  window.close();
  console.log("\nALL LAYOUT CHECKS PASSED");
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
