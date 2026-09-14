// Confirms the real knowledge-base-embed.html page + built bundle can drive a real
// multi-file upload through the actual form (not just hitting the API directly).
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
  const email = `embed-page-test-${Date.now()}@example.test`;
  const password = "test-password-123!";
  await admin.auth.admin.createUser({ email, password, email_confirm: true });
  const anon = createClient(SUPABASE_URL, ANON_KEY);
  const { data: signIn } = await anon.auth.signInWithPassword({ email, password });
  await fetch(`${API_BASE}/api/tenant-provision`, {
    method: "POST",
    headers: { Authorization: `Bearer ${signIn.session.access_token}` },
  });

  const authHash =
    `access_token=${signIn.session.access_token}&refresh_token=${signIn.session.refresh_token}` +
    `&expires_in=3600&token_type=bearer&type=magiclink`;
  const html = await (await fetch(`${API_BASE}/knowledge-base-embed.html`)).text();
  const dom = new JSDOM(html, {
    url: `${API_BASE}/knowledge-base-embed.html#${authHash}`,
    runScripts: "outside-only",
    resources: "usable",
  });
  const { window } = dom;
  // A FormData/File built inside jsdom's own realm isn't recognized by Node's real
  // fetch (undici) as a valid body -- rebuild it with Node's real FormData/File
  // right before handing it to the real fetch.
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

  // Wait for the page's own async main() (requireSession -> getSupabaseClient ->
  // fetch /api/config -> getSession) to finish and wire up the form listener before
  // dispatching -- there's a real async gap between the elements existing in the DOM
  // and the site script actually attaching its handlers to them.
  await new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (window.localStorage.getItem("sb-127-auth-token")) return resolve();
      if (Date.now() - start > 10000) return reject(new Error("timed out waiting for session to establish"));
      setTimeout(check, 100);
    };
    check();
  });

  const file1 = new window.File(["Return window is 14 days."], "policy.txt", { type: "text/plain" });
  const file2 = new window.File(["not allowed"], "sheet.pdf", { type: "application/pdf" });
  Object.defineProperty(window.document.querySelector("#doc-files-input"), "files", {
    value: [file1, file2],
    configurable: true,
  });
  window.document.querySelector("#upload-form").dispatchEvent(new window.Event("submit", { cancelable: true, bubbles: true }));

  await new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (window.document.querySelectorAll("#upload-results .upload-result").length >= 2) return resolve();
      if (Date.now() - start > 10000) return reject(new Error("timed out waiting for upload results"));
      setTimeout(check, 200);
    };
    check();
  });

  const items = [...window.document.querySelectorAll("#upload-results .upload-result")];
  const rendered = items.map((el) => ({ ok: el.classList.contains("ok"), text: el.textContent }));
  console.log("  rendered results:", rendered);

  assert(items.length === 2, "both file results rendered");
  assert(rendered[0].ok && rendered[0].text.includes("policy.txt") && rendered[0].text.includes("embedded"), "policy.txt shows as embedded");
  assert(!rendered[1].ok && rendered[1].text.includes("sheet.pdf") && rendered[1].text.includes("unsupported"), "sheet.pdf shows as rejected");

  window.close();
  console.log("\nALL EMBED PAGE UPLOAD CHECKS PASSED");
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
