// Verifies the fix for "Too many subrequests by single Worker invocation": the
// client now splits a large selection into multiple requests instead of sending
// everything in one, and the server rejects an oversized single request outright
// (defense in depth for direct API callers). Uses 18 tiny files to exercise real
// batching (8 + 8 + 2) without the cost of a huge real run.
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
  const email = `batch-upload-test-${Date.now()}@example.test`;
  const password = "test-password-123!";
  await admin.auth.admin.createUser({ email, password, email_confirm: true });
  const anon = createClient(SUPABASE_URL, ANON_KEY);
  const { data: signIn } = await anon.auth.signInWithPassword({ email, password });
  const accessToken = signIn.session.access_token;
  await fetch(`${API_BASE}/api/tenant-provision`, { method: "POST", headers: { Authorization: `Bearer ${accessToken}` } });

  console.log("--- Server rejects an oversized single request (defense in depth) ---");
  const oversizedForm = new FormData();
  for (let i = 0; i < 11; i++) {
    oversizedForm.append("files", new Blob([`content ${i}`], { type: "text/plain" }), `file-${i}.txt`);
  }
  const oversizedRes = await fetch(`${API_BASE}/api/ingest-document-files`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
    body: oversizedForm,
  });
  assert(oversizedRes.status === 400, `11 files in one request rejected (${oversizedRes.status})`);
  const oversizedBody = await oversizedRes.json();
  assert(/too many files/i.test(oversizedBody.error), `rejection reason mentions the file count (got "${oversizedBody.error}")`);

  console.log("--- Real page: 18 files split into 3 batches (8+8+2), all succeed ---");
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

  let ingestRequestCount = 0;
  const batchSizes = [];
  window.fetch = async (url, init) => {
    let realInit = init;
    // A FormData/File built inside jsdom's own realm isn't recognized by Node's real
    // fetch (undici) as a valid body -- rebuild it with Node's real FormData/File.
    if (init?.body && typeof init.body.entries === "function") {
      const entries = [...init.body.entries()];
      if (String(url).includes("/api/ingest-document-files")) {
        ingestRequestCount++;
        batchSizes.push(entries.filter(([k]) => k === "files").length);
      }
      const realForm = new FormData();
      for (const [key, value] of entries) {
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
      if (Date.now() - start > 10000) return reject(new Error("timed out waiting for session"));
      setTimeout(check, 100);
    };
    check();
  });

  const filesInput = window.document.querySelector("#doc-files-input");
  const files = Array.from({ length: 18 }, (_, i) => new window.File([`Fact number ${i}.`], `doc-${i}.txt`, { type: "text/plain" }));
  Object.defineProperty(filesInput, "files", { value: files, configurable: true });
  filesInput.dispatchEvent(new window.Event("change", { bubbles: true }));

  window.document.querySelector("#upload-form").dispatchEvent(new window.Event("submit", { cancelable: true, bubbles: true }));

  await new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (window.document.querySelectorAll("#upload-results .upload-result").length >= 18) return resolve();
      if (Date.now() - start > 30000) return reject(new Error(`timed out -- only ${window.document.querySelectorAll("#upload-results .upload-result").length}/18 results so far`));
      setTimeout(check, 300);
    };
    check();
  });

  console.log("  requests made:", ingestRequestCount, "batch sizes:", batchSizes);
  assert(ingestRequestCount === 3, `18 files sent as 3 separate requests (got ${ingestRequestCount})`);
  assert(JSON.stringify(batchSizes) === JSON.stringify([8, 8, 2]), `batch sizes are 8/8/2 (got ${JSON.stringify(batchSizes)})`);

  const allItems = [...window.document.querySelectorAll("#upload-results .upload-result")];
  console.log("  all results:", allItems.map((el) => el.textContent));
  const okResults = allItems.filter((el) => el.classList.contains("ok"));
  assert(okResults.length === 18, `all 18 files embedded successfully (got ${okResults.length})`);

  const countEl = window.document.querySelector("#file-picker-count");
  assert(countEl.textContent === "No files chosen", "picker cleared once submission started");

  window.close();
  console.log("\nALL BATCH UPLOAD CHECKS PASSED");
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
