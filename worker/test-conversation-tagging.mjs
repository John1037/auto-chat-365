// Real end-to-end verification of the "AI Analysis" two-pass tagging pipeline (real
// DeepSeek/OpenAI, not mocked): a preliminary tag appears within seconds of the
// FIRST message (fire-and-forget via ctx.waitUntil, no cron/backdating needed), a
// final tag replaces it once the conversation goes quiet and the hourly cron runs,
// resuming a finally-tagged conversation marks it non-final again (without deleting
// the tag) so it still has data until it's re-tagged, the tag survives its parent
// conversation being deleted (the whole point of this being a separate table --
// see migration 0028), and RLS keeps one tenant's tags invisible to another's.
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

async function getTag(service, conversationId) {
  const { data } = await service.from("conversation_topics").select("*").eq("conversation_id", conversationId).maybeSingle();
  return data;
}

async function main() {
  const service = createClient(SUPABASE_URL, SERVICE_KEY);
  const cleanupTenantIds = [];

  console.log("--- Preliminary tag appears within seconds of the first message -- no backdating or cron needed ---");
  const startedAt = Date.now();
  const { tenantId: tenantA, widget: widgetA } = await makeWidget(service);
  cleanupTenantIds.push(tenantA);
  const accessTokenA = await startSession(widgetA);

  const first = await chat(accessTokenA, "Hi, I'd like to know about your pricing plans, specifically the enterprise tier.");
  const conversationId = first.conversation_id;
  assert(typeof conversationId === "string" && conversationId.length > 0, "a real conversation was created via the real chat pipeline");

  const preliminaryTag = await waitFor(() => getTag(service, conversationId), "a preliminary conversation_topics row appears from just the first message");
  const preliminaryLatencyMs = Date.now() - startedAt;
  console.log(`  preliminary tag appeared ${preliminaryLatencyMs}ms after the first message: "${preliminaryTag.topic_label}" -- ${preliminaryTag.summary}`);
  assert(typeof preliminaryTag.topic_label === "string" && preliminaryTag.topic_label.length > 0, "topic_label is a real, non-empty string from the LLM");
  assert(typeof preliminaryTag.summary === "string" && preliminaryTag.summary.length > 0, "summary is a real, non-empty string from the LLM");
  assert(preliminaryTag.is_final === false, "the first-message tag is marked preliminary (is_final = false)");
  assert(preliminaryTag.tenant_id === tenantA, "tagged row carries the correct tenant_id");
  assert(preliminaryTag.widget_id === widgetA.id, "tagged row carries the correct widget_id");
  assert(!!preliminaryTag.conversation_date, "tagged row carries a conversation_date");
  assert(!!preliminaryTag.conversation_started_at, "tagged row carries a real conversation_started_at timestamp");

  console.log("--- A second message doesn't delete the preliminary tag -- data stays available mid-conversation ---");
  await chat(accessTokenA, "Does the enterprise tier include priority support?", conversationId);
  await new Promise((r) => setTimeout(r, 500));
  {
    const stillThere = await getTag(service, conversationId);
    assert(!!stillThere, "the tag row still exists after a second message (not deleted)");
    assert(stillThere.is_final === false, "still marked non-final (unchanged, it was already preliminary)");
  }

  console.log("--- Backdating to quiet + triggering the cron replaces the preliminary tag with a final one ---");
  await service.from("conversations").update({ last_message_at: new Date(Date.now() - 60 * 60 * 1000).toISOString() }).eq("id", conversationId);
  await triggerCron();
  const finalTag = await waitFor(async () => {
    const row = await getTag(service, conversationId);
    return row && row.is_final ? row : null;
  }, "the preliminary tag is replaced by a final one after the conversation goes quiet");
  console.log("  final tag:", finalTag.topic_label, "--", finalTag.summary);
  assert(finalTag.id !== preliminaryTag.id, "the final tag is a genuinely new row, not the preliminary one (delete-then-insert)");
  assert(finalTag.is_final === true, "the cron-produced tag is marked final");

  console.log("--- Resuming a finally-tagged conversation marks it non-final again, without deleting it ---");
  await chat(accessTokenA, "Actually, one more question -- do you support SSO?", conversationId);
  await new Promise((r) => setTimeout(r, 500));
  {
    const afterResume = await getTag(service, conversationId);
    assert(!!afterResume, "the final tag's row still exists after the conversation resumes (not deleted)");
    assert(afterResume.id === finalTag.id, "it's the same row, just demoted");
    assert(afterResume.is_final === false, "resuming marked it non-final, so the cron will reconsider it");
  }

  console.log("--- Re-quieting and re-triggering the cron produces a fresh final tag ---");
  await service.from("conversations").update({ last_message_at: new Date(Date.now() - 60 * 60 * 1000).toISOString() }).eq("id", conversationId);
  await triggerCron();
  const retaggedRow = await waitFor(async () => {
    const row = await getTag(service, conversationId);
    return row && row.is_final && row.id !== finalTag.id ? row : null;
  }, "the conversation gets re-tagged (a new final row) after resuming and going quiet again");
  assert(retaggedRow.is_final === true, "the re-tag is final");

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

  console.log("--- Account deletion removes conversation_topics too (including preliminary, never-finalized tags) ---");
  {
    const { tenantId: tenantC, widget: widgetC } = await makeWidget(service);
    const accessTokenC = await startSession(widgetC);
    const chatResult = await chat(accessTokenC, "What are your refund policies?");
    await waitFor(() => getTag(service, chatResult.conversation_id), "conversation gets its preliminary tag before we test account deletion");

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
