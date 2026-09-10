// Real browser-equivalent check (jsdom) of the sidebar's live widget sub-list:
// signs in for real via a Mailpit-captured magic link (same implicit-flow path a
// real browser takes), lands on the actual dashboard.html, lets the real widgets.js
// bundle run, and inspects the DOM it produces.
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
  const email = `sidebar-test-${Date.now()}@example.test`;
  const anon = createClient(SUPABASE_URL, ANON_KEY);

  console.log("--- Requesting magic link + creating 3 named widgets ---");
  const { error: otpError } = await anon.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: `${API_BASE}/dashboard.html` },
  });
  if (otpError) throw otpError;

  const magicLink = await latestMagicLinkFor(email);
  console.log("  found magic link:", magicLink.slice(0, 80) + "...");

  // Follow the link ourselves first (outside jsdom) just to get a session + create
  // widgets ahead of loading the dashboard -- the link is single-use.
  const verifyResponse = await fetch(magicLink, { redirect: "manual" });
  const redirectLocation = verifyResponse.headers.get("location");
  const hash = new URL(redirectLocation).hash.slice(1);
  const params = new URLSearchParams(hash);
  const accessToken = params.get("access_token");
  assert(!!accessToken, "magic link redirect carried an access_token");

  await fetch(`${API_BASE}/api/tenant-provision`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  for (const name of ["Widget One", "Widget Two", "Widget Three"]) {
    await fetch(`${API_BASE}/api/create-widget`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    await new Promise((r) => setTimeout(r, 1100)); // distinct created_at timestamps
  }

  console.log("--- Requesting a second magic link (first is now consumed) and loading dashboard.html for real ---");
  const { error: otpError2 } = await anon.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: `${API_BASE}/dashboard.html` },
  });
  if (otpError2) throw otpError2;
  const magicLink2 = await latestMagicLinkFor(email);

  // jsdom doesn't execute <script type="module"> tags at all (a known, long-standing
  // limitation), so navigating jsdom straight to the magic link and letting it load
  // dashboard.html naturally would never run widgets.js. Instead: follow the redirect
  // ourselves to get the real post-auth URL (dashboard.html#access_token=...), build a
  // jsdom window at that URL from the page's actual HTML, and eval the actual built
  // bundle into it directly -- same technique already used for the widget.js bundle,
  // and the bundle is a self-contained script (esbuild left no import/export
  // statements in it), so eval-ing it is equivalent to a browser executing it as a
  // module with no external imports left to resolve.
  const verify2 = await fetch(magicLink2, { redirect: "manual" });
  const dashboardUrl = verify2.headers.get("location");

  const html = await (await fetch(`${API_BASE}/dashboard.html`)).text();
  const dom = new JSDOM(html, { url: dashboardUrl, runScripts: "outside-only", resources: "usable", pretendToBeVisual: true });
  const { window } = dom;
  window.fetch = (url, init) => fetch(new URL(url, API_BASE), init);

  const bundle = readFileSync(new URL("public/widgets.js", import.meta.url), "utf8");
  window.eval(bundle);

  await new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      const list = window.document.querySelector("#sidebar-widget-list");
      if (list && list.children.length > 0) return resolve();
      if (Date.now() - start > 15000) return reject(new Error("timed out waiting for sidebar widget list to populate"));
      setTimeout(check, 300);
    };
    check();
  });

  const sidebarNames = [...window.document.querySelectorAll("#sidebar-widget-list a")].map((a) => a.textContent);
  const sidebarHrefs = [...window.document.querySelectorAll("#sidebar-widget-list a")].map((a) => a.getAttribute("href"));
  console.log("  sidebar widget list (order shown):", sidebarNames);

  assert(sidebarNames.length === 4, `sidebar lists all 4 widgets (got ${sidebarNames.length})`);
  assert(
    JSON.stringify(sidebarNames) === JSON.stringify(["Widget Three", "Widget Two", "Widget One", "Default widget"]),
    "sidebar widget list is sorted newest-created first",
  );
  assert(
    sidebarHrefs.every((h) => h.startsWith("/widget-settings.html?id=")),
    "every sidebar widget link points at widget-settings.html",
  );

  const cardTitles = [...window.document.querySelectorAll(".widget-card-title")].map((el) => el.textContent);
  console.log("  workspace card list (order shown):", cardTitles);
  assert(
    JSON.stringify(cardTitles) === JSON.stringify(["Default widget", "Widget One", "Widget Two", "Widget Three"]),
    "main workspace list is still oldest-first (unchanged, separate ordering) and matches the same 4 widgets",
  );

  console.log("\nALL SIDEBAR CHECKS PASSED");
  window.close();
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
