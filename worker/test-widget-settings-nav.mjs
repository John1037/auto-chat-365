// Regression test for the "flash to widget settings then bounces back to All
// widgets" bug: requireSession() used to strip the *entire* query string (not just
// the magic-link hash) before widget-settings.ts ever got to read its own ?id= param,
// so it always redirected itself back to /dashboard.html. Verifies the fix holds by
// running the real built bundle against a real signed-in session, same technique as
// test-sidebar-widgets.mjs.
import { createClient } from "@supabase/supabase-js";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";

const SUPABASE_URL = "http://127.0.0.1:54321";
const ANON_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;
const API_BASE = "http://127.0.0.1:8787";
const MAILPIT = "http://127.0.0.1:54324";

function assert(cond, msg) {
  if (!cond) throw new Error("ASSERTION FAILED: " + msg);
  console.log("  ok:", msg);
}

async function latestMagicLinkFor(email) {
  for (let i = 0; i < 10; i++) {
    const list = await (await fetch(`${MAILPIT}/api/v1/messages?limit=25`)).json();
    const msg = list.messages.find((m) => m.To.some((t) => t.Address === email));
    if (msg) {
      const full = await (await fetch(`${MAILPIT}/api/v1/message/${msg.ID}`)).json();
      const match = full.Text.match(/https?:\/\/\S+/);
      if (match) return match[0].replace(/[)\].,]+$/, "");
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`no magic link email found for ${email}`);
}

async function main() {
  const email = `settings-nav-test-${Date.now()}@example.test`;
  const anon = createClient(SUPABASE_URL, ANON_KEY);

  console.log("--- Sign in, create a widget ---");
  const { error: otpError } = await anon.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: `${API_BASE}/dashboard.html` },
  });
  if (otpError) throw otpError;
  const magicLink = await latestMagicLinkFor(email);
  const verify = await fetch(magicLink, { redirect: "manual" });
  const firstRedirect = new URL(verify.headers.get("location"));
  const accessToken = new URLSearchParams(firstRedirect.hash.slice(1)).get("access_token");

  await fetch(`${API_BASE}/api/tenant-provision`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  const createRes = await fetch(`${API_BASE}/api/create-widget`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Nav Test Widget" }),
  });
  const createBody = await createRes.json();
  if (!createBody.widget) {
    console.error("  create-widget response:", createRes.status, createBody);
    throw new Error("create-widget did not return a widget");
  }
  const { widget } = createBody;
  console.log("  widget id:", widget.id);

  console.log("--- Request a fresh magic link (this session is for loading the page, not the API calls above) ---");
  const { error: otpError2 } = await anon.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: `${API_BASE}/dashboard.html` },
  });
  if (otpError2) throw otpError2;
  const magicLink2 = await latestMagicLinkFor(email);
  const verify2 = await fetch(magicLink2, { redirect: "manual" });
  const dashboardUrlWithHash = new URL(verify2.headers.get("location"));

  // Same landing URL a real click on the widget's card/sidebar link would produce:
  // dashboard.html's own post-auth redirect target, but pointed at widget-settings.html
  // with the widget's id -- simulating "already signed in, then clicked into a widget".
  const settingsUrl = new URL(`${API_BASE}/widget-settings.html?id=${widget.id}`);
  settingsUrl.hash = dashboardUrlWithHash.hash;

  const html = await (await fetch(`${API_BASE}/widget-settings.html`)).text();
  const dom = new JSDOM(html, {
    url: settingsUrl.toString(),
    runScripts: "outside-only",
    resources: "usable",
    pretendToBeVisual: true,
  });
  const { window } = dom;
  window.fetch = (url, init) => fetch(new URL(url, API_BASE), init);

  const bundle = readFileSync(new URL("public/widget-settings.js", import.meta.url), "utf8");
  window.eval(bundle);

  await new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      const heading = window.document.querySelector("#page-heading")?.textContent;
      if (heading && heading !== "Widget settings") return resolve();
      if (Date.now() - start > 10000) return reject(new Error("timed out waiting for widget settings to load"));
      setTimeout(check, 200);
    };
    check();
  });

  console.log("  final window.location.pathname:", window.location.pathname);
  console.log("  final window.location.search:", window.location.search);
  console.log("  page heading:", window.document.querySelector("#page-heading").textContent);

  assert(window.location.pathname === "/widget-settings.html", "did not bounce away from widget-settings.html");
  assert(window.location.search === `?id=${widget.id}`, "?id= query param survived the hash cleanup");
  assert(window.document.querySelector("#page-heading").textContent === "Nav Test Widget", "heading shows the real widget's name (not redirected before loading it)");
  assert(window.document.querySelector("#content").hidden === false, "settings content is visible, not stuck on loading/error");

  console.log("\nALL NAVIGATION CHECKS PASSED");
  window.close();
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
