// Verifies both Embed Document submit buttons stay disabled until their
// preconditions are met, and re-disable appropriately afterward.
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
  const email = `button-state-test-${Date.now()}@example.test`;
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
  window.fetch = (url, init) => fetch(new URL(url, API_BASE), init);
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

  const uploadButton = window.document.querySelector("#upload-submit-button");
  const embedButton = window.document.querySelector("#embed-document-submit-button");
  const titleInput = window.document.querySelector("#doc-title-input");
  const contentInput = window.document.querySelector("#doc-content-input");
  const filesInput = window.document.querySelector("#doc-files-input");

  console.log("--- Initial state: both buttons disabled ---");
  assert(uploadButton.disabled === true, "Embed files starts disabled (no files chosen)");
  assert(embedButton.disabled === true, "Embed document starts disabled (title and content both empty)");

  console.log("--- Embed document: enables only once BOTH title and content are filled ---");
  titleInput.value = "Refund policy";
  titleInput.dispatchEvent(new window.Event("input", { bubbles: true }));
  assert(embedButton.disabled === true, "still disabled with only title filled");

  contentInput.value = "Refunds within 30 days.";
  contentInput.dispatchEvent(new window.Event("input", { bubbles: true }));
  assert(embedButton.disabled === false, "enabled once both title and content are filled");

  titleInput.value = "";
  titleInput.dispatchEvent(new window.Event("input", { bubbles: true }));
  assert(embedButton.disabled === true, "disabled again if title is cleared back out");
  titleInput.value = "Refund policy";
  titleInput.dispatchEvent(new window.Event("input", { bubbles: true }));

  console.log("--- Embed files: enables once a file is chosen, disables again after removing it ---");
  const file = new window.File(["hi"], "notes.txt", { type: "text/plain" });
  Object.defineProperty(filesInput, "files", { value: [file], configurable: true });
  filesInput.dispatchEvent(new window.Event("change", { bubbles: true }));
  assert(uploadButton.disabled === false, "enabled once a file is chosen");

  window.document.querySelector(".file-picker-item-remove").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  assert(uploadButton.disabled === true, "disabled again once the only file is removed");

  window.close();
  console.log("\nALL BUTTON-STATE CHECKS PASSED");
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
