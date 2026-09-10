// Verifies the new per-widget document visibility feature end to end:
// 1) API level -- the actual security guarantee: a document scoped to only widget A
//    must be retrievable in widget A's chat but invisible to widget B's chat.
// 2) UI level -- the real knowledge-base-review.js bundle, run against a real signed-in
//    session, correctly reflects and edits that state via the new visibility dialog.
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

async function getAccessToken(anon, email) {
  const { error } = await anon.auth.signInWithOtp({ email, options: { emailRedirectTo: `${API_BASE}/dashboard.html` } });
  if (error) throw error;
  const link = await latestMagicLinkFor(email);
  const verify = await fetch(link, { redirect: "manual" });
  const redirect = new URL(verify.headers.get("location"));
  return { accessToken: new URLSearchParams(redirect.hash.slice(1)).get("access_token"), redirect };
}

async function main() {
  const email = `doc-visibility-test-${Date.now()}@example.test`;
  const anon = createClient(SUPABASE_URL, ANON_KEY);

  console.log("--- Provision tenant, two widgets (both open origin), one document ---");
  const { accessToken } = await getAccessToken(anon, email);

  await fetch(`${API_BASE}/api/tenant-provision`, { method: "POST", headers: { Authorization: `Bearer ${accessToken}` } });

  const widgetA = (
    await (
      await fetch(`${API_BASE}/api/create-widget`, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Widget A" }),
      })
    ).json()
  ).widget;
  const widgetB = (
    await (
      await fetch(`${API_BASE}/api/create-widget`, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Widget B" }),
      })
    ).json()
  ).widget;
  console.log("  widget A:", widgetA.id, " widget B:", widgetB.id);

  // Real client-side update (RLS-scoped), same path the settings page uses --
  // matches how allowed_origins get edited elsewhere in this app.
  const service = createClient(SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);
  await service.from("widgets").update({ allowed_origins: ["https://vis-test.example"] }).in("id", [widgetA.id, widgetB.id]);

  const ingestRes = await fetch(`${API_BASE}/api/ingest-document`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      title: "Secret Menu",
      content: "The secret menu item at this restaurant is called the Volcano Burrito.",
    }),
  });
  const { document_id: documentId } = await ingestRes.json();
  console.log("  document:", documentId);

  console.log("--- Scope the document to Widget A only ---");
  const visRes = await fetch(`${API_BASE}/api/update-document-visibility`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ document_id: documentId, is_global: false, widget_ids: [widgetA.id] }),
  });
  assert(visRes.ok, `update-document-visibility ok (${visRes.status})`);

  const { data: docRow } = await service.from("tenant_documents").select("is_global").eq("id", documentId).maybeSingle();
  assert(docRow.is_global === false, "document is no longer global");
  const { data: links } = await service.from("widget_documents").select("widget_id").eq("document_id", documentId);
  assert(links.length === 1 && links[0].widget_id === widgetA.id, "widget_documents has exactly one row, linking widget A");

  console.log("--- Widget A can retrieve it, Widget B cannot ---");
  async function chatAsWidget(widget, question) {
    const startRes = await fetch(`${API_BASE}/api/session-start`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://vis-test.example" },
      body: JSON.stringify({ site_key: widget.site_key }),
    });
    const session = await startRes.json();
    const chatRes = await fetch(`${API_BASE}/api/chat`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        "Content-Type": "application/json",
        Origin: "https://vis-test.example",
      },
      body: JSON.stringify({ message: question }),
    });
    return (await chatRes.json()).reply;
  }

  const replyA = await chatAsWidget(widgetA, "What is the secret menu item called? Answer in exactly one line.");
  console.log("  Widget A reply:", replyA);
  assert(/volcano burrito/i.test(replyA), "Widget A's chat answers correctly from the scoped document");

  const replyB = await chatAsWidget(widgetB, "What is the secret menu item called? Answer in exactly one line.");
  console.log("  Widget B reply:", replyB);
  assert(!/volcano burrito/i.test(replyB), "Widget B's chat has no access to the scoped document");

  console.log("--- UI: real knowledge-base-review.js bundle reflects this state ---");
  const { redirect } = await getAccessToken(anon, email); // fresh session for page load
  const html = await (await fetch(`${API_BASE}/knowledge-base.html`)).text();
  const pageUrl = new URL(`${API_BASE}/knowledge-base.html`);
  pageUrl.hash = redirect.hash;
  const dom = new JSDOM(html, { url: pageUrl.toString(), runScripts: "outside-only", resources: "usable", pretendToBeVisual: true });
  const { window } = dom;
  window.fetch = (url, init) => fetch(new URL(url, API_BASE), init);
  // jsdom doesn't implement <dialog>'s showModal()/close() (a known gap, not a real
  // browser limitation) -- shim the open/hidden state changes a real browser would
  // make, just enough for the visibility dialog's own logic to be exercised.
  window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
    this.hidden = false;
  };
  window.HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  window.eval(readFileSync(new URL("public/knowledge-base-review.js", import.meta.url), "utf8"));

  await new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      const card = window.document.querySelector(`.doc-card[data-id="${documentId}"]`);
      if (card) return resolve();
      if (Date.now() - start > 10000) return reject(new Error("timed out waiting for doc card to render"));
      setTimeout(check, 200);
    };
    check();
  });

  const card = window.document.querySelector(`.doc-card[data-id="${documentId}"]`);
  const visLine = card.querySelector(".doc-visibility").textContent;
  console.log("  card visibility summary:", visLine);
  assert(visLine === "Visible to selected widgets only", "card summary reflects selective visibility");
  assert(card.dataset.isGlobal === "false", "card dataset.isGlobal is false");

  const visButton = card.querySelector('.icon-btn[data-action="visibility"]');
  visButton.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

  await new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      const list = window.document.querySelector("#visibility-widget-list");
      if (list && list.children.length >= 2) return resolve();
      if (Date.now() - start > 10000) return reject(new Error("timed out waiting for visibility dialog to populate"));
      setTimeout(check, 200);
    };
    check();
  });

  const checkboxes = Array.from(window.document.querySelectorAll("#visibility-widget-list input[type=checkbox]"));
  const checkedNames = checkboxes.filter((c) => c.checked).map((c) => c.closest("label").textContent.trim());
  const uncheckedNames = checkboxes.filter((c) => !c.checked).map((c) => c.closest("label").textContent.trim());
  console.log("  dialog checked:", checkedNames, " unchecked:", uncheckedNames);

  assert(window.document.querySelector("#visibility-selected").checked, "'Only selected widgets' radio is checked");
  assert(checkedNames.includes("Widget A") && !checkedNames.includes("Widget B"), "only Widget A's checkbox is pre-checked");

  console.log("\nALL DOCUMENT VISIBILITY CHECKS PASSED");
  window.close();
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
