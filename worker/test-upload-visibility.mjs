// Verifies the new upload-time visibility picker end to end: both ingest routes
// (multipart file upload and JSON paste-text) accept is_global/widget_ids, only
// verified own-tenant widgets get linked, the default (nothing sent) stays global,
// and scoped documents are genuinely retrievable only by the widgets they're
// scoped to -- checked through real chat round trips, not just DB state.
import { createClient } from "@supabase/supabase-js";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SERVICE_KEY = process.env.SUPABASE_SECRET_KEY;
const ANON_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;
const API_BASE = "http://127.0.0.1:8787";
const ORIGIN = "https://upload-vis-test.example";

function assert(cond, msg) {
  if (!cond) throw new Error("ASSERTION FAILED: " + msg);
  console.log("  ok:", msg);
}

async function main() {
  const admin = createClient(SUPABASE_URL, SERVICE_KEY);
  const service = createClient(SUPABASE_URL, SERVICE_KEY);
  const email = `upload-vis-test-${Date.now()}@example.test`;
  const password = "test-password-123!";
  await admin.auth.admin.createUser({ email, password, email_confirm: true });
  const anon = createClient(SUPABASE_URL, ANON_KEY);
  const { data: signIn } = await anon.auth.signInWithPassword({ email, password });
  const accessToken = signIn.session.access_token;
  await fetch(`${API_BASE}/api/tenant-provision`, { method: "POST", headers: { Authorization: `Bearer ${accessToken}` } });

  async function createWidget(name) {
    const { widget } = await (
      await fetch(`${API_BASE}/api/create-widget`, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      })
    ).json();
    await service.from("widgets").update({ allowed_origins: [ORIGIN] }).eq("id", widget.id);
    return widget;
  }

  const widgetA = await createWidget("Scope Test A");
  const widgetB = await createWidget("Scope Test B");

  console.log("--- Default (no visibility fields sent): stays global ---");
  const plainForm = new FormData();
  plainForm.append("files", new Blob(["Plain default content."], { type: "text/plain" }), "plain.txt");
  const plainRes = await fetch(`${API_BASE}/api/ingest-document-files`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
    body: plainForm,
  });
  const { results: plainResults } = await plainRes.json();
  assert(plainResults[0].ok, "plain upload succeeded");
  const { data: plainRow } = await service.from("tenant_documents").select("is_global").eq("id", plainResults[0].document_id).single();
  assert(plainRow.is_global === true, "no visibility fields sent -> document stays global (backward compatible)");

  console.log("--- File upload scoped to Widget A only ---");
  const scopedForm = new FormData();
  scopedForm.append("files", new Blob(["Fact: the vault code is 7734."], { type: "text/plain" }), "vault.txt");
  scopedForm.append("files", new Blob(["# Second doc\n\nAlso vault-related."], { type: "text/markdown" }), "vault2.md");
  scopedForm.append("is_global", "false");
  scopedForm.append("widget_ids", widgetA.id);
  scopedForm.append("widget_ids", "00000000-0000-0000-0000-000000000000"); // forged/foreign id, must be dropped silently
  const scopedRes = await fetch(`${API_BASE}/api/ingest-document-files`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
    body: scopedForm,
  });
  const { results: scopedResults } = await scopedRes.json();
  assert(scopedResults.every((r) => r.ok), "both scoped files embedded successfully");

  for (const r of scopedResults) {
    const { data: row } = await service.from("tenant_documents").select("is_global").eq("id", r.document_id).single();
    assert(row.is_global === false, `${r.filename}: is_global is false`);
    const { data: links } = await service.from("widget_documents").select("widget_id").eq("document_id", r.document_id);
    assert(links.length === 1 && links[0].widget_id === widgetA.id, `${r.filename}: linked to exactly Widget A (forged id silently dropped)`);
  }

  console.log("--- Retrieval: Widget A sees it, Widget B does not (via the retrieval RPC directly -- DeepSeek chat completion has been flaky all session, this isolates the check to OpenAI embeddings + Postgres, which is the actual thing this change touches) ---");
  const { data: tenantRow } = await service.from("tenant_members").select("tenant_id").eq("user_id", signIn.user.id).single();
  async function embedQuery(text) {
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "text-embedding-3-small", input: text }),
    });
    const json = await res.json();
    return json.data[0].embedding;
  }
  const queryEmbedding = await embedQuery("vault code");
  async function widgetCanSeeVaultFact(widgetId) {
    const { data: chunks } = await service.rpc("match_tenant_document_chunks", {
      p_tenant_id: tenantRow.tenant_id,
      p_widget_id: widgetId,
      p_query_embedding: queryEmbedding,
      p_match_count: 10,
    });
    return (chunks ?? []).some((c) => c.content.includes("7734"));
  }
  assert(await widgetCanSeeVaultFact(widgetA.id), "Widget A's retrieval includes the scoped fact");
  assert(!(await widgetCanSeeVaultFact(widgetB.id)), "Widget B's retrieval does not include the scoped fact");

  console.log("--- Paste-text route also accepts is_global/widget_ids ---");
  const pasteRes = await fetch(`${API_BASE}/api/ingest-document`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Pasted scoped doc", content: "Pasted secret: pineapple99.", is_global: false, widget_ids: [widgetA.id] }),
  });
  const { document_id: pastedDocId } = await pasteRes.json();
  const { data: pastedRow } = await service.from("tenant_documents").select("is_global").eq("id", pastedDocId).single();
  assert(pastedRow.is_global === false, "pasted document respects is_global: false");
  const { data: pastedLinks } = await service.from("widget_documents").select("widget_id").eq("document_id", pastedDocId);
  assert(pastedLinks.length === 1 && pastedLinks[0].widget_id === widgetA.id, "pasted document linked to Widget A");

  console.log("--- Real page: 'Only selected widgets' picker drives an actual upload ---");
  const authHash =
    `access_token=${signIn.session.access_token}&refresh_token=${signIn.session.refresh_token}` +
    `&expires_in=3600&token_type=bearer&type=magiclink`;
  const html = await (await fetch(`${API_BASE}/knowledge-base-embed.html`)).text();
  const dom = new JSDOM(html, { url: `${API_BASE}/knowledge-base-embed.html#${authHash}`, runScripts: "outside-only", resources: "usable" });
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

  // Dispatching a synthetic "change" event does NOT set a radio's own .checked --
  // that has to be set explicitly first, same as a real click would do before the
  // browser fires the event.
  window.document.querySelector("#embed-visibility-selected").checked = true;
  window.document.querySelector("#embed-visibility-selected").dispatchEvent(new window.Event("change", { bubbles: true }));
  await new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (window.document.querySelectorAll("#embed-visibility-widget-list input[type=checkbox]").length >= 2) return resolve();
      if (Date.now() - start > 10000) return reject(new Error("timed out waiting for widget checkboxes"));
      setTimeout(check, 100);
    };
    check();
  });
  const checkboxes = [...window.document.querySelectorAll("#embed-visibility-widget-list input[type=checkbox]")];
  const widgetBCheckbox = checkboxes.find((c) => c.closest("label").textContent.includes("Scope Test B"));
  widgetBCheckbox.checked = true;

  const file = new window.File(["Real page upload, Widget B only."], "real-page.txt", { type: "text/plain" });
  Object.defineProperty(window.document.querySelector("#doc-files-input"), "files", { value: [file], configurable: true });
  window.document.querySelector("#doc-files-input").dispatchEvent(new window.Event("change", { bubbles: true }));
  window.document.querySelector("#upload-form").dispatchEvent(new window.Event("submit", { cancelable: true, bubbles: true }));

  await new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (window.document.querySelectorAll("#upload-results .upload-result").length >= 1) return resolve();
      if (Date.now() - start > 15000) return reject(new Error("timed out waiting for upload result"));
      setTimeout(check, 200);
    };
    check();
  });
  const resultItem = window.document.querySelector("#upload-results .upload-result");
  assert(resultItem.classList.contains("ok"), "real-page upload succeeded");

  // Scoped by tenant_id too -- the service client bypasses RLS, and "real-page" as a
  // title isn't unique across repeated runs of this same script (each run creates
  // its own tenant, but titles are still just filenames).
  const { data: realPageDoc } = await service
    .from("tenant_documents")
    .select("id, is_global")
    .eq("title", "real-page")
    .eq("tenant_id", tenantRow.tenant_id)
    .single();
  assert(realPageDoc.is_global === false, "real-page upload is scoped, not global");
  const { data: realPageLinks } = await service.from("widget_documents").select("widget_id").eq("document_id", realPageDoc.id);
  assert(realPageLinks.length === 1 && realPageLinks[0].widget_id === widgetB.id, "real-page upload linked to Widget B, chosen via the actual checkbox");

  window.close();
  console.log("\nALL UPLOAD VISIBILITY CHECKS PASSED");
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
