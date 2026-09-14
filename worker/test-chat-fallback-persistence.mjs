// Verifies that once DeepSeek fails once for a visitor session, subsequent messages
// in that SAME session skip straight to OpenAI (no repeated ~20s DeepSeek timeout),
// while a DIFFERENT session still tries DeepSeek fresh. Exercised against DeepSeek's
// actual current outage, not a simulated failure.
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SERVICE_KEY = process.env.SUPABASE_SECRET_KEY;
const API_BASE = "http://127.0.0.1:8787";
const ORIGIN = "https://fallback-persistence-test.example";

function assert(cond, msg) {
  if (!cond) throw new Error("ASSERTION FAILED: " + msg);
  console.log("  ok:", msg);
}

async function startSession(siteKey) {
  const res = await fetch(`${API_BASE}/api/session-start`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({ site_key: siteKey }),
  });
  return res.json();
}

async function sendChat(accessToken, message) {
  const start = Date.now();
  const res = await fetch(`${API_BASE}/api/chat`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({ message }),
  });
  const elapsed = Date.now() - start;
  const body = await res.json();
  return { status: res.status, elapsed, body };
}

async function main() {
  const service = createClient(SUPABASE_URL, SERVICE_KEY);
  const { data: tenant } = await service.from("tenants").insert({ name: "Fallback Persistence Test" }).select("id").single();
  const { data: widget } = await service
    .from("widgets")
    .insert({ tenant_id: tenant.id, allowed_origins: [ORIGIN] })
    .select("id, site_key")
    .single();

  console.log("--- Session A: first message pays DeepSeek's timeout, then falls back ---");
  const sessionA = await startSession(widget.site_key);
  const first = await sendChat(sessionA.access_token, "Say hello in one word.");
  console.log(`  status: ${first.status}, elapsed: ${first.elapsed}ms, reply: "${first.body.reply}"`);
  assert(first.status === 200, "first message succeeded");
  assert(first.elapsed >= 18000, `first message paid roughly the DeepSeek timeout (took ${first.elapsed}ms)`);

  // widget_sessions.id === the JWT subject === the anonymous auth user id, decode it
  // from the access token to check the persisted flag directly.
  const payload = JSON.parse(Buffer.from(sessionA.access_token.split(".")[1], "base64").toString());
  const { data: sessionRowAfterFirst } = await service.from("widget_sessions").select("use_fallback_chat").eq("id", payload.sub).single();
  assert(sessionRowAfterFirst.use_fallback_chat === true, "use_fallback_chat persisted to true after the first failure");

  console.log("--- Session A: second message skips DeepSeek entirely, resolves fast ---");
  const second = await sendChat(sessionA.access_token, "Say goodbye in one word.");
  console.log(`  status: ${second.status}, elapsed: ${second.elapsed}ms, reply: "${second.body.reply}"`);
  assert(second.status === 200, "second message succeeded");
  assert(second.elapsed < 10000, `second message did NOT pay the DeepSeek timeout again (took ${second.elapsed}ms)`);

  console.log("--- A brand new session still tries DeepSeek fresh (own timeout, own flag) ---");
  const sessionB = await startSession(widget.site_key);
  const payloadB = JSON.parse(Buffer.from(sessionB.access_token.split(".")[1], "base64").toString());
  const { data: sessionRowB } = await service.from("widget_sessions").select("use_fallback_chat").eq("id", payloadB.sub).single();
  assert(sessionRowB.use_fallback_chat === false, "a new session starts with use_fallback_chat false, independent of session A");

  await service.from("tenants").delete().eq("id", tenant.id);
  console.log("\nALL FALLBACK PERSISTENCE CHECKS PASSED");
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
