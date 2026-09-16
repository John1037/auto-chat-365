// Real end-to-end verification of full tenant account deletion: seeds a tenant
// with real data across every table the deletion touches (widget, document +
// chunks, widget_documents link, a real chat conversation/message via the actual
// chat route, and a rate-limit counter), calls the real API route, then confirms
// every single row is gone -- not just that the tenants row disappeared.
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SERVICE_KEY = process.env.SUPABASE_SECRET_KEY;
const ANON_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;
const API_BASE = "http://127.0.0.1:8787";
const ORIGIN = "https://delete-account-test.example";

function assert(cond, msg) {
  if (!cond) throw new Error("ASSERTION FAILED: " + msg);
  console.log("  ok:", msg);
}

async function main() {
  const service = createClient(SUPABASE_URL, SERVICE_KEY);

  console.log("--- Seed a real owner account + tenant via the real API ---");
  const email = `delete-account-test-${Date.now()}@example.test`;
  const password = "test-password-123!";
  const { error: createErr } = await service.auth.admin.createUser({ email, password, email_confirm: true });
  if (createErr) throw createErr;
  const anon = createClient(SUPABASE_URL, ANON_KEY);
  const { data: signIn } = await anon.auth.signInWithPassword({ email, password });
  const accessToken = signIn.session.access_token;

  const provisionRes = await fetch(`${API_BASE}/api/tenant-provision`, { method: "POST", headers: { Authorization: `Bearer ${accessToken}` } });
  const { tenant, widget } = await provisionRes.json();
  await service.from("widgets").update({ allowed_origins: [ORIGIN] }).eq("id", widget.id);
  console.log("  tenant:", tenant.id, "widget:", widget.id);

  console.log("--- Seed real data across every table the deletion touches ---");
  // A second widget, to prove widget_documents cleanup covers ALL of the tenant's
  // widgets, not just the default one.
  const { data: secondWidget } = await service.from("widgets").insert({ tenant_id: tenant.id, allowed_origins: [ORIGIN] }).select("id").single();

  const { data: doc } = await service
    .from("tenant_documents")
    .insert({ tenant_id: tenant.id, title: "Test doc", source_type: "text", raw_content: "hello", status: "ready", is_global: false })
    .select("id")
    .single();
  await service.from("tenant_document_chunks").insert({ tenant_id: tenant.id, document_id: doc.id, chunk_index: 0, content: "hello", embedding: Array(1536).fill(0.001) });
  await service.from("widget_documents").insert([
    { widget_id: widget.id, document_id: doc.id },
    { widget_id: secondWidget.id, document_id: doc.id },
  ]);

  // A real conversation/message pair via the actual chat route (also exercises a
  // real widget_session row + rate_limit_counters rows).
  const startRes = await fetch(`${API_BASE}/api/session-start`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({ site_key: widget.site_key }),
  });
  const session = await startRes.json();
  const chatRes = await fetch(`${API_BASE}/api/chat`, {
    method: "POST",
    headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({ message: "Say the word cucumber and nothing else." }),
  });
  const chatBody = await chatRes.json();
  assert(chatRes.status === 200, `real chat message succeeded (${chatRes.status})`);

  // Confirm every seeded row actually exists before deletion, so the later
  // "confirmed gone" checks prove something real was removed, not that it never
  // existed in the first place.
  const before = {
    tenant: await service.from("tenants").select("id").eq("id", tenant.id).maybeSingle(),
    members: await service.from("tenant_members").select("id").eq("tenant_id", tenant.id),
    widgets: await service.from("widgets").select("id").eq("tenant_id", tenant.id),
    widgetDocs: await service.from("widget_documents").select("widget_id").in("widget_id", [widget.id, secondWidget.id]),
    docs: await service.from("tenant_documents").select("id").eq("tenant_id", tenant.id),
    chunks: await service.from("tenant_document_chunks").select("id").eq("tenant_id", tenant.id),
    sessions: await service.from("widget_sessions").select("id").eq("tenant_id", tenant.id),
    conversations: await service.from("conversations").select("id").eq("tenant_id", tenant.id),
    messages: await service.from("messages").select("id").eq("tenant_id", tenant.id),
    rateLimits: await service.from("rate_limit_counters").select("tenant_id").eq("tenant_id", tenant.id),
  };
  assert(before.tenant.data !== null, "tenant row exists before deletion");
  assert(before.members.data.length >= 1, `tenant_members exist before deletion (${before.members.data.length})`);
  assert(before.widgets.data.length === 2, `both widgets exist before deletion (${before.widgets.data.length})`);
  assert(before.widgetDocs.data.length === 2, `widget_documents exist before deletion (${before.widgetDocs.data.length})`);
  assert(before.docs.data.length === 1, "tenant_documents exists before deletion");
  assert(before.chunks.data.length === 1, "tenant_document_chunks exists before deletion");
  assert(before.sessions.data.length >= 1, "widget_sessions exists before deletion");
  assert(before.conversations.data.length >= 1, "conversations exists before deletion");
  assert(before.messages.data.length >= 2, `messages (user+assistant) exist before deletion (${before.messages.data.length})`);
  assert(before.rateLimits.data.length >= 1, "rate_limit_counters exist before deletion");

  console.log("--- Reject deletion: wrong confirmation phrase ---");
  const wrongPhraseRes = await fetch(`${API_BASE}/api/delete-tenant-account`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ confirmation: "delete account" }),
  });
  assert(wrongPhraseRes.status === 400, `wrong-case confirmation phrase rejected (${wrongPhraseRes.status})`);
  const stillThere = await service.from("tenants").select("id").eq("id", tenant.id).maybeSingle();
  assert(stillThere.data !== null, "tenant NOT deleted after a rejected confirmation");

  console.log("--- Reject deletion: caller who isn't a member of this tenant ---");
  const email2 = `delete-account-outsider-${Date.now()}@example.test`;
  await service.auth.admin.createUser({ email: email2, password, email_confirm: true });
  const { data: signIn2 } = await anon.auth.signInWithPassword({ email: email2, password });
  const outsiderRes = await fetch(`${API_BASE}/api/delete-tenant-account`, {
    method: "POST",
    headers: { Authorization: `Bearer ${signIn2.session.access_token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ confirmation: "DELETE ACCOUNT" }),
  });
  assert(outsiderRes.status === 403, `a user with no tenant membership is rejected (${outsiderRes.status})`);

  console.log("--- Real deletion, correct confirmation phrase ---");
  const deleteRes = await fetch(`${API_BASE}/api/delete-tenant-account`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ confirmation: "DELETE ACCOUNT" }),
  });
  const deleteBody = await deleteRes.json();
  console.log("  response:", deleteRes.status, JSON.stringify(deleteBody));
  assert(deleteRes.status === 200, `deletion succeeded (${deleteRes.status})`);

  console.log("--- Confirm every single row is actually gone ---");
  const after = {
    tenant: await service.from("tenants").select("id").eq("id", tenant.id).maybeSingle(),
    members: await service.from("tenant_members").select("id").eq("tenant_id", tenant.id),
    widgets: await service.from("widgets").select("id").eq("tenant_id", tenant.id),
    widgetDocs: await service.from("widget_documents").select("widget_id").in("widget_id", [widget.id, secondWidget.id]),
    docs: await service.from("tenant_documents").select("id").eq("tenant_id", tenant.id),
    chunks: await service.from("tenant_document_chunks").select("id").eq("tenant_id", tenant.id),
    sessions: await service.from("widget_sessions").select("id").eq("tenant_id", tenant.id),
    conversations: await service.from("conversations").select("id").eq("tenant_id", tenant.id),
    messages: await service.from("messages").select("id").eq("tenant_id", tenant.id),
    rateLimits: await service.from("rate_limit_counters").select("tenant_id").eq("tenant_id", tenant.id),
  };
  assert(after.tenant.data === null, "tenants row is gone");
  assert(after.members.data.length === 0, "tenant_members rows are gone");
  assert(after.widgets.data.length === 0, "widgets rows (both) are gone");
  assert(after.widgetDocs.data.length === 0, "widget_documents rows are gone");
  assert(after.docs.data.length === 0, "tenant_documents rows are gone");
  assert(after.chunks.data.length === 0, "tenant_document_chunks rows are gone");
  assert(after.sessions.data.length === 0, "widget_sessions rows are gone");
  assert(after.conversations.data.length === 0, "conversations rows are gone");
  assert(after.messages.data.length === 0, "messages rows are gone");
  assert(after.rateLimits.data.length === 0, "rate_limit_counters rows are gone");

  console.log("\nALL DELETE-TENANT-ACCOUNT CHECKS PASSED");
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
