// Verifies the widget logo upload feature end to end: the Worker route (auth,
// ownership check, type/size validation, Storage upload, DB write), the resulting
// public URL actually serves the image, and the real widget bundle + settings page
// pick it up correctly.
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

// 1x1 transparent PNG.
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

async function makeOwner(email) {
  const admin = createClient(SUPABASE_URL, SERVICE_KEY);
  const password = "test-password-123!";
  const { error: createErr } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (createErr) throw createErr;
  const anon = createClient(SUPABASE_URL, ANON_KEY);
  const { data: signIn, error: signInErr } = await anon.auth.signInWithPassword({ email, password });
  if (signInErr) throw signInErr;
  return { accessToken: signIn.session.access_token, refreshToken: signIn.session.refresh_token, client: anon };
}

async function createWidget(accessToken, name) {
  await fetch(`${API_BASE}/api/tenant-provision`, { method: "POST", headers: { Authorization: `Bearer ${accessToken}` } });
  const { widget } = await (
    await fetch(`${API_BASE}/api/create-widget`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    })
  ).json();
  return widget;
}

async function main() {
  const service = createClient(SUPABASE_URL, SERVICE_KEY);

  console.log("--- Owner A: upload a valid logo ---");
  const ownerA = await makeOwner(`logo-test-a-${Date.now()}@example.test`);
  const widgetA = await createWidget(ownerA.accessToken, "Logo Test Widget");

  const pngBytes = Buffer.from(TINY_PNG_BASE64, "base64");
  const formA = new FormData();
  formA.append("widget_id", widgetA.id);
  formA.append("file", new Blob([pngBytes], { type: "image/png" }), "logo.png");

  const uploadRes = await fetch(`${API_BASE}/api/upload-widget-logo`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ownerA.accessToken}` },
    body: formA,
  });
  assert(uploadRes.ok, `upload succeeded (${uploadRes.status})`);
  const { logo_url: logoUrl } = await uploadRes.json();
  console.log("  logo_url:", logoUrl);
  assert(logoUrl.includes("/storage/v1/object/public/widget-logos/"), "logo_url points at the public storage path");

  const imgRes = await fetch(logoUrl);
  assert(imgRes.ok, `the public logo URL actually serves the image (${imgRes.status})`);
  assert(imgRes.headers.get("content-type") === "image/png", "served with the correct content-type");

  const { data: dbRow } = await service.from("widgets").select("logo_url").eq("id", widgetA.id).maybeSingle();
  assert(dbRow.logo_url === logoUrl, "widgets.logo_url matches the returned URL");

  console.log("--- Rejections ---");
  const oversized = new FormData();
  oversized.append("widget_id", widgetA.id);
  oversized.append("file", new Blob([new Uint8Array(3 * 1024 * 1024)], { type: "image/png" }), "big.png");
  const oversizedRes = await fetch(`${API_BASE}/api/upload-widget-logo`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ownerA.accessToken}` },
    body: oversized,
  });
  assert(oversizedRes.status === 400, `oversized file rejected (${oversizedRes.status})`);

  const wrongType = new FormData();
  wrongType.append("widget_id", widgetA.id);
  wrongType.append("file", new Blob(["not an image"], { type: "text/plain" }), "notes.txt");
  const wrongTypeRes = await fetch(`${API_BASE}/api/upload-widget-logo`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ownerA.accessToken}` },
    body: wrongType,
  });
  assert(wrongTypeRes.status === 400, `disallowed mime type rejected (${wrongTypeRes.status})`);

  console.log("--- Owner B cannot upload a logo for owner A's widget ---");
  const ownerB = await makeOwner(`logo-test-b-${Date.now()}@example.test`);
  await fetch(`${API_BASE}/api/tenant-provision`, { method: "POST", headers: { Authorization: `Bearer ${ownerB.accessToken}` } });
  const crossForm = new FormData();
  crossForm.append("widget_id", widgetA.id);
  crossForm.append("file", new Blob([pngBytes], { type: "image/png" }), "logo.png");
  const crossRes = await fetch(`${API_BASE}/api/upload-widget-logo`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ownerB.accessToken}` },
    body: crossForm,
  });
  assert(crossRes.status === 404, `cross-tenant upload rejected (${crossRes.status})`);

  console.log("--- widget-config + real widget.js bundle reflect the uploaded logo ---");
  await service.from("widgets").update({ allowed_origins: ["https://logo-test.example"] }).eq("id", widgetA.id);
  const cfg = await (
    await fetch(`${API_BASE}/api/widget-config?site_key=${widgetA.site_key}`, { headers: { Origin: "https://logo-test.example" } })
  ).json();
  assert(cfg.logo_url === logoUrl, "widget-config returns the uploaded logo_url");

  const dom = new JSDOM(
    `<!doctype html><html><body><script src="${API_BASE}/widget.js" data-site-key="${widgetA.site_key}"></script></body></html>`,
    { url: "https://logo-test.example/", runScripts: "outside-only", resources: "usable" },
  );
  const { window } = dom;
  window.fetch = (url, init = {}) => fetch(url, { ...init, headers: { ...init.headers, Origin: "https://logo-test.example" } });
  const scriptEl = window.document.querySelector("script");
  Object.defineProperty(window.document, "currentScript", { value: scriptEl, configurable: true });
  Object.defineProperty(window.document, "readyState", { value: "complete", configurable: true });
  window.eval(readFileSync(new URL("public/widget.js", import.meta.url), "utf8"));
  await new Promise((r) => setTimeout(r, 1200));
  const logoImg = window.document.getElementById("autochat365-widget-root").shadowRoot.querySelector(".panel-logo");
  assert(logoImg?.getAttribute("src") === logoUrl, "the real widget bundle renders the uploaded logo");
  window.close();

  console.log("--- widget-settings.html: upload via the real form, then remove ---");
  const authHash =
    `access_token=${ownerA.accessToken}&refresh_token=${ownerA.refreshToken}&expires_in=3600&token_type=bearer&type=magiclink`;
  const settingsHtml = await (await fetch(`${API_BASE}/widget-settings.html`)).text();
  const settingsDom = new JSDOM(settingsHtml, {
    url: `${API_BASE}/widget-settings.html?id=${widgetA.id}#${authHash}`,
    runScripts: "outside-only",
    resources: "usable",
  });
  const sw = settingsDom.window;
  // A FormData/File built inside jsdom's own realm isn't recognized by Node's real
  // fetch (undici) as a valid body -- cross-realm objects fail instanceof checks
  // even with identical shapes. Rebuild it with Node's real FormData/File before
  // handing it to the real fetch, bridging the two realms.
  sw.fetch = async (url, init) => {
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
  sw.eval(readFileSync(new URL("public/widget-settings.js", import.meta.url), "utf8"));

  await new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (sw.document.querySelector("#content")?.hidden === false) return resolve();
      if (Date.now() - start > 10000) return reject(new Error("timed out waiting for settings form"));
      setTimeout(check, 200);
    };
    check();
  });

  assert(sw.document.querySelector("#logo-preview").hidden === false, "settings page shows the existing logo preview");
  assert(sw.document.querySelector("#logo-remove-button").hidden === false, "Remove button is visible when a logo exists");

  sw.addEventListener("error", (e) => console.error("window error:", e.error || e.message));
  sw.addEventListener("unhandledrejection", (e) => console.error("unhandled rejection:", e.reason));

  // File.prototype constructor is unavailable via jsdom's own global in outside-only
  // mode reliably, so build one with Node's real File (global since Node 20) and let
  // the DataTransfer-less assignment stand in for a user's file picker choice.
  const file = new sw.File([pngBytes], "new-logo.png", { type: "image/png" });
  Object.defineProperty(sw.document.querySelector("#logo-file-input"), "files", { value: [file], configurable: true });
  sw.document.querySelector("#logo-file-input").dispatchEvent(new sw.Event("change", { bubbles: true }));

  await new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (sw.document.querySelector("#logo-status")?.textContent === "Logo updated.") return resolve();
      if (Date.now() - start > 10000) return reject(new Error("timed out waiting for upload to finish"));
      setTimeout(check, 200);
    };
    check();
  });
  assert(true, "settings page's own upload control completed a real upload");

  sw.document.querySelector("#logo-remove-button").dispatchEvent(new sw.MouseEvent("click", { bubbles: true }));
  await new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (sw.document.querySelector("#logo-status")?.textContent === "Logo removed.") return resolve();
      if (Date.now() - start > 10000) return reject(new Error("timed out waiting for removal"));
      setTimeout(check, 200);
    };
    check();
  });
  const { data: afterRemove } = await service.from("widgets").select("logo_url").eq("id", widgetA.id).maybeSingle();
  assert(afterRemove.logo_url === null, "logo_url cleared in the DB after Remove");
  assert(sw.document.querySelector("#logo-preview").hidden === true, "preview hidden after Remove");
  assert(sw.document.querySelector("#logo-empty").hidden === false, "empty-state text shown after Remove");

  settingsDom.window.close();
  console.log("\nALL LOGO UPLOAD CHECKS PASSED");
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
