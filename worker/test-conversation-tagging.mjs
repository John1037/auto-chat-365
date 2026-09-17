// Real end-to-end verification of the "AI Analysis" tagging pipeline: a real chat
// conversation (real DeepSeek/OpenAI, not mocked) gets marked quiet, the hourly cron
// job (triggered here via wrangler dev's local scheduled-trigger endpoint) tags it
// with a real LLM call, the tag survives its parent conversation being deleted (the
// whole point of this being a separate table -- see migration 0028), resuming a
// tagged conversation invalidates its stale tag, and RLS keeps one tenant's tags
// invisible to another's.
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SERVICE_KEY = process.env.SUPABASE_SECRET_KEY;
const API_BASE = "http://127.0.0.1:8787";
const ORIGIN = "https://tagging-test.example";

function assert(cond, msg) {
  if (!cond) throw new Error("ASSERTION FAILED: " + msg);
  console.log("  ok:", msg);
}

async function makeWidget(service, overrides = {}) {
  const { data: tenant } = await service.from("tenants").insert({ name: `Tagging Test ${Date.now()}-${Math.random()}` }).select("id").single();
  const { data: widget } = await service
    .from("widgets")
    .insert({ tenant_id: tenant.id, allowed_origins: [ORIGIN], ...overrides })
    .select("id, site_key")
    .single();
  return { tenantId: tenant.id, widget };
}

async function startSession(widget) {
  const startRes = await fetch(`${API_BASE}/api/session-start`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({ site_key: widget.site_key }),
  });
  return (await startRes.json()).access_token;
}

async function chat(accessToken, message, conversationId) {
  const res = await fetch(`${API_BASE}/api/chat`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({ message, conversation_id: conversationId }),
  });
  return res.json();
}

async function triggerCron() {
  await fetch(`${API_BASE}/cdn-cgi/local/scheduled`);
}

async function waitFor(predicate, message, timeoutMs = 20000) {
  const start = Date.now();
  while (true) {
    const result = await predicate();
    if (result) return result;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for: ${message}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function main() {
  const service = createClient(SUPABASE_URL, SERVICE_KEY);
  const cleanupTenantIds = [];

  console.log("--- Real conversation -> backdated quiet -> real tagging via the hourly cron ---");
  const { tenantId: tenantA, widget: widgetA } = await makeWidget(service);
  cleanupTenantIds.push(tenantA);
  const accessTokenA = await startSession(widgetA);

  const first = await chat(accessTokenA, "Hi, I'd like to know about your pricing plans, specifically the enterprise tier.");
  const conversationId = first.conversation_id;
  assert(typeof conversationId === "string" && conversationId.length > 0, "a real conversation was created via the real chat pipeline");
  await chat(accessTokenA, "Does the enterprise tier include priority support?", conversationId);

  await service.from("conversations").update({ last_message_at: new Date(Date.now() - 60 * 60 * 1000).toISOString() }).eq("id", conversationId);

  await triggerCron();

  const taggedRow = await waitFor(async () => {
    const { data } = await service.from("conversation_topics").select("*").eq("conversation_id", conversationId).maybeSingle();
    return data;
  }, "a conversation_topics row appears for the real conversation");

  console.log("  tagged as:", taggedRow.topic_label, "--", taggedRow.summary);
  assert(typeof taggedRow.topic_label === "string" && taggedRow.topic_label.length > 0, "topic_label is a real, non-empty string from the LLM");
  assert(typeof taggedRow.summary === "string" && taggedRow.summary.length > 0, "summary is a real, non-empty string from the LLM");
  assert(taggedRow.tenant_id === tenantA, "tagged row carries the correct tenant_id");
  assert(taggedRow.widget_id === widgetA.id, "tagged row carries the correct widget_id");
  assert(!!taggedRow.conversation_date, "tagged row carries a conversation_date");

  console.log("--- Resuming the tagged conversation invalidates its stale tag ---");
  await chat(accessTokenA, "Actually, one more question -- do you support SSO?", conversationId);
  await new Promise((r) => setTimeout(r, 500)); // the delete happens inline in chat.ts, but give it a beat
  {
    const { data } = await service.from("conversation_topics").select("id").eq("conversation_id", conversationId).maybeSingle();
    assert(!data, "the stale tag was deleted when the conversation resumed");
  }

  console.log("--- Re-quieting and re-triggering the cron re-tags the resumed conversation ---");
  await service.from("conversations").update({ last_message_at: new Date(Date.now() - 60 * 60 * 1000).toISOString() }).eq("id", conversationId);
  await triggerCron();
  const retaggedRow = await waitFor(async () => {
    const { data } = await service.from("conversation_topics").select("*").eq("conversation_id", conversationId).maybeSingle();
    return data;
  }, "the conversation gets re-tagged after resuming and going quiet again");
  assert(retaggedRow.id !== taggedRow.id, "the re-tag is a genuinely new row, not the stale one");

  console.log("--- Tag survives its parent conversation being deleted (the whole point of the separate table) ---");
  await service.from("messages").delete().eq("conversation_id", conversationId);
  await service.from("conversations").delete().eq("id", conversationId);
  {
    const { data } = await service.from("conversation_topics").select("id, conversation_id").eq("id", retaggedRow.id).maybeSingle();
    assert(!!data, "the conversation_topics row still exists after its parent conversation is deleted");
    assert(data.conversation_id === null, "conversation_id was cleared to null (on delete set null), not cascaded away");
  }

  console.log("--- Cross-tenant isolation: another tenant's owner cannot see tenant A's topic tags ---");
  {
    const anon = createClient(SUPABASE_URL, process.env.SUPABASE_PUBLISHABLE_KEY);
    const password = "test-password-123!";
    const emailB = `tagging-test-b-${Date.now()}@example.test`;
    await service.auth.admin.createUser({ email: emailB, password, email_confirm: true });
    const { data: signInB } = await anon.auth.signInWithPassword({ email: emailB, password });
    const provisionRes = await fetch(`${API_BASE}/api/tenant-provision`, { method: "POST", headers: { Authorization: `Bearer ${signInB.session.access_token}` } });
    const { tenant: tenantB } = await provisionRes.json();
    cleanupTenantIds.push(tenantB.id);

    const clientB = createClient(SUPABASE_URL, process.env.SUPABASE_PUBLISHABLE_KEY);
    await clientB.auth.signInWithPassword({ email: emailB, password });
    const { data, error } = await clientB.from("conversation_topics").select("*").eq("id", retaggedRow.id);
    assert(!error, `no error, just filtered to nothing (${error?.message})`);
    assert(data.length === 0, "tenant B sees none of tenant A's topic tags");
  }

  console.log("--- Account deletion removes conversation_topics too ---");
  {
    const { tenantId: tenantC, widget: widgetC } = await makeWidget(service);
    const accessTokenC = await startSession(widgetC);
    const chatResult = await chat(accessTokenC, "What are your refund policies?");
    await service.from("conversations").update({ last_message_at: new Date(Date.now() - 60 * 60 * 1000).toISOString() }).eq("id", chatResult.conversation_id);
    await triggerCron();
    await waitFor(async () => {
      const { data } = await service.from("conversation_topics").select("id").eq("conversation_id", chatResult.conversation_id).maybeSingle();
      return data;
    }, "conversation gets tagged before we test account deletion");

    await service.rpc("delete_tenant_account", { p_tenant_id: tenantC });
    const { data: remaining } = await service.from("conversation_topics").select("id").eq("tenant_id", tenantC);
    assert((remaining ?? []).length === 0, "delete_tenant_account removed this tenant's conversation_topics rows too");
  }

  for (const id of cleanupTenantIds) {
    await service.from("tenants").delete().eq("id", id);
  }
  console.log("\nALL CONVERSATION TAGGING CHECKS PASSED");
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
