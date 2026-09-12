// Confirms the dashboard's widget-settings.html page correctly wires up BOTH the
// logo and avatar upload controls (they now share a generic wireImageUpload()
// helper keyed by an id prefix) -- loads existing state and performs a real avatar
// upload through the real form.
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
  const email = `avatar-form-test-${Date.now()}@example.test`;
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
      body: JSON.stringify({ name: "Avatar Form Test" }),
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

  assert(window.document.querySelector("#avatar-empty").hidden === false, "avatar empty-state shown initially");
  assert(window.document.querySelector("#avatar-preview").hidden === true, "avatar preview hidden initially");
  assert(window.document.querySelector("#logo-empty").hidden === false, "logo empty-state shown initially (unaffected by avatar wiring)");

  const pngBytes = Buffer.from(TINY_PNG_BASE64, "base64");
  const file = new window.File([pngBytes], "avatar.png", { type: "image/png" });
  Object.defineProperty(window.document.querySelector("#avatar-file-input"), "files", { value: [file], configurable: true });
  window.document.querySelector("#avatar-file-input").dispatchEvent(new window.Event("change", { bubbles: true }));

  await new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (window.document.querySelector("#avatar-status")?.textContent === "Updated.") return resolve();
      if (Date.now() - start > 10000) return reject(new Error("timed out waiting for avatar upload"));
      setTimeout(check, 200);
    };
    check();
  });

  assert(window.document.querySelector("#avatar-preview").hidden === false, "avatar preview now visible");
  assert(window.document.querySelector("#logo-empty").hidden === false, "logo control untouched by the avatar upload");

  const service = createClient(SUPABASE_URL, SERVICE_KEY);
  const { data: row } = await service.from("widgets").select("avatar_url, logo_url").eq("id", widget.id).maybeSingle();
  assert(!!row.avatar_url, "avatar_url persisted to the DB");
  assert(row.logo_url === null, "logo_url untouched");

  window.close();
  console.log("\nALL AVATAR SETTINGS FORM CHECKS PASSED");
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
