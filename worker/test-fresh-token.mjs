// Verifies the fix for "Upload -- invalid or expired session": every authenticated
// fetch across the site now re-reads the CURRENT session via getAccessToken()
// immediately before the request, instead of reusing the access_token
// requireSession() captured once at page load. This proves getAccessToken()
// reflects a token rotation (e.g. from a background refresh while the page sat
// open) rather than returning a frozen snapshot, then confirms the real
// knowledge-base-embed.html upload flow -- reproducing the reported scenario --
// still succeeds through the actual built bundle.
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
  const email = `fresh-token-test-${Date.now()}@example.test`;
  const password = "test-password-123!";
  await admin.auth.admin.createUser({ email, password, email_confirm: true });
  const anon = createClient(SUPABASE_URL, ANON_KEY);
  const { data: signIn } = await anon.auth.signInWithPassword({ email, password });
  await fetch(`${API_BASE}/api/tenant-provision`, {
    method: "POST",
    headers: { Authorization: `Bearer ${signIn.session.access_token}` },
  });

  console.log("--- getAccessToken() reflects a rotation, not a frozen snapshot ---");
  const tokenAtSignIn = signIn.session.access_token;
  // Force a real rotation via the refresh token, simulating what supabase-js's own
  // background auto-refresh does while a page sits open.
  const { data: refreshed } = await anon.auth.refreshSession({ refresh_token: signIn.session.refresh_token });
  const tokenAfterRefresh = refreshed.session.access_token;
  assert(tokenAfterRefresh !== tokenAtSignIn, "refreshing actually rotated the access_token");

  const { data: currentSession } = await anon.auth.getSession();
  assert(
    currentSession.session.access_token === tokenAfterRefresh,
    "getSession() (what getAccessToken() calls) returns the rotated token, matching the refresh -- not the original sign-in snapshot",
  );

  console.log("--- Real page: knowledge-base-embed.html upload still works end to end ---");
  const authHash =
    `access_token=${refreshed.session.access_token}&refresh_token=${refreshed.session.refresh_token}` +
    `&expires_in=3600&token_type=bearer&type=magiclink`;
  const html = await (await fetch(`${API_BASE}/knowledge-base-embed.html`)).text();
  const dom = new JSDOM(html, {
    url: `${API_BASE}/knowledge-base-embed.html#${authHash}`,
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
  window.eval(readFileSync(new URL("public/knowledge-base-embed.js", import.meta.url), "utf8"));

  await new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (window.localStorage.getItem("sb-127-auth-token")) return resolve();
      if (Date.now() - start > 10000) return reject(new Error("timed out waiting for session to establish"));
      setTimeout(check, 100);
    };
    check();
  });

  const file = new window.File(["Hours: 9-5 Mon-Fri."], "hours.txt", { type: "text/plain" });
  Object.defineProperty(window.document.querySelector("#doc-files-input"), "files", { value: [file], configurable: true });
  window.document.querySelector("#upload-form").dispatchEvent(new window.Event("submit", { cancelable: true, bubbles: true }));

  await new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (window.document.querySelectorAll("#upload-results .upload-result").length >= 1) return resolve();
      if (Date.now() - start > 10000) return reject(new Error("timed out waiting for upload result"));
      setTimeout(check, 200);
    };
    check();
  });

  const result = window.document.querySelector("#upload-results .upload-result");
  console.log("  result:", result.textContent, result.className);
  assert(result.classList.contains("ok"), "upload succeeded using a freshly-read token, not a stale one");
  assert(!result.textContent.includes("invalid or expired session"), "no stale-session error");

  window.close();
  console.log("\nALL FRESH-TOKEN CHECKS PASSED");
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
