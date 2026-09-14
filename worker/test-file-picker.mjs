// Verifies the redesigned file picker on Embed Document: choosing files a second
// time adds to the pending list rather than replacing it, individual files can be
// deselected, the header count/list reflect the real pending set, and "Embed files"
// only sends what's actually still in the box.
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
  const email = `file-picker-test-${Date.now()}@example.test`;
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
      if (Date.now() - start > 10000) return reject(new Error("timed out waiting for session"));
      setTimeout(check, 100);
    };
    check();
  });

  const filesInput = window.document.querySelector("#doc-files-input");
  const countEl = window.document.querySelector("#file-picker-count");
  const listEl = window.document.querySelector("#file-picker-list");

  console.log("--- Initial empty state ---");
  assert(countEl.textContent === "No files chosen", `starts with no files chosen (got "${countEl.textContent}")`);
  assert(listEl.children.length === 0, "list starts empty");

  console.log("--- First pick: two files ---");
  const fileA = new window.File(["Hours: 9-5."], "hours.txt", { type: "text/plain" });
  const fileB = new window.File(["# Refunds"], "refunds.md", { type: "text/markdown" });
  Object.defineProperty(filesInput, "files", { value: [fileA, fileB], configurable: true });
  filesInput.dispatchEvent(new window.Event("change", { bubbles: true }));

  assert(countEl.textContent === "2 files chosen", `count shows 2 (got "${countEl.textContent}")`);
  let names = [...listEl.querySelectorAll(".file-picker-item-name")].map((el) => el.textContent);
  assert(JSON.stringify(names) === JSON.stringify(["hours.txt", "refunds.md"]), "both filenames listed");

  console.log("--- Second pick: one more file -- should ADD, not replace ---");
  const fileC = new window.File(["Recipe body"], "recipe.docx", { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
  Object.defineProperty(filesInput, "files", { value: [fileC], configurable: true });
  filesInput.dispatchEvent(new window.Event("change", { bubbles: true }));

  assert(countEl.textContent === "3 files chosen", `count shows 3 after second pick (got "${countEl.textContent}")`);
  names = [...listEl.querySelectorAll(".file-picker-item-name")].map((el) => el.textContent);
  assert(JSON.stringify(names) === JSON.stringify(["hours.txt", "refunds.md", "recipe.docx"]), "all three filenames now listed, nothing lost from the first pick");

  console.log("--- Deselect one file manually ---");
  const removeButtons = [...listEl.querySelectorAll(".file-picker-item-remove")];
  const refundsRemoveButton = removeButtons[names.indexOf("refunds.md")];
  refundsRemoveButton.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

  assert(countEl.textContent === "2 files chosen", `count drops to 2 after removing one (got "${countEl.textContent}")`);
  names = [...listEl.querySelectorAll(".file-picker-item-name")].map((el) => el.textContent);
  assert(JSON.stringify(names) === JSON.stringify(["hours.txt", "recipe.docx"]), "refunds.md is gone, the other two remain");

  console.log("--- Embed files: only the remaining two get sent ---");
  window.document.querySelector("#upload-form").dispatchEvent(new window.Event("submit", { cancelable: true, bubbles: true }));

  await new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (window.document.querySelectorAll("#upload-results .upload-result").length >= 2) return resolve();
      if (Date.now() - start > 15000) return reject(new Error("timed out waiting for upload results"));
      setTimeout(check, 200);
    };
    check();
  });

  const resultNames = [...window.document.querySelectorAll("#upload-results .upload-result-name")].map((el) => el.textContent);
  console.log("  embedded:", resultNames);
  assert(resultNames.length === 2, "exactly two files were sent to the server");
  assert(resultNames.includes("hours.txt") && resultNames.includes("recipe.docx"), "the two remaining files are the ones embedded");
  assert(!resultNames.includes("refunds.md"), "the removed file was never sent");

  assert(countEl.textContent === "No files chosen", "picker resets to empty after a successful embed");
  assert(listEl.children.length === 0, "list is cleared after a successful embed");

  window.close();
  console.log("\nALL FILE PICKER CHECKS PASSED");
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
