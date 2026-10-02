// Verifies the explicit requirement behind the preliminary-tagging feature: it must
// run as a genuinely parallel, fire-and-forget operation (via ctx.waitUntil in
// chat.ts) and must never add to the chat reply's own latency.
//
// Can't prove this by checking "the tag doesn't exist yet when the response
// returns" -- that's not a reliable signal either way: the tagging call starts
// *before* the main reply's own LLM call in chat.ts, so on a run where the real
// tagging call happens to be faster than the real reply call, the tag can
// legitimately already exist by response time even though it was never awaited.
// Parallel execution guarantees the response doesn't wait on tagging; it does not
// guarantee tagging finishes later.
//
// What *is* a reliable signal, without mocking either LLM call: compare the first
// message of a brand-new conversation (the only message that ever triggers
// preliminary tagging) against a follow-up message on that same conversation (which
// never does). If tagging were mistakenly awaited inline, the first message would
// be reliably slower than the second by roughly the tagging call's own duration;
// run back-to-back against the same live providers, they should instead land in the
// same rough ballpark.
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SERVICE_KEY = process.env.SUPABASE_SECRET_KEY;
const API_BASE = "http://127.0.0.1:8787";
const ORIGIN = "https://tagging-latency-test.example";

function assert(cond, msg) {
  if (!cond) throw new Error("ASSERTION FAILED: " + msg);
  console.log("  ok:", msg);
}

async function main() {
  const service = createClient(SUPABASE_URL, SERVICE_KEY);
  const { data: tenant } = await service.from("tenants").insert({ name: `Tagging Latency Test ${Date.now()}` }).select("id").single();
  const { data: widget } = await service.from("widgets").insert({ tenant_id: tenant.id, allowed_origins: [ORIGIN] }).select("id, site_key").single();

  const startRes = await fetch(`${API_BASE}/api/session-start`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({ site_key: widget.site_key }),
  });
  const { access_token } = await startRes.json();

  console.log("--- Sending the first message of a brand-new conversation (this is what triggers preliminary tagging) ---");
  const requestStart = Date.now();
  const chatRes = await fetch(`${API_BASE}/api/chat`, {
    method: "POST",
    headers: { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({ message: "Hi, I'd like to know about your pricing plans, specifically the enterprise tier." }),
  });
  const chatBody = await chatRes.json();
  const responseElapsedMs = Date.now() - requestStart;
  console.log(`  chat response returned after ${responseElapsedMs}ms`);
  assert(chatRes.status === 200, `chat request succeeded (got ${chatRes.status})`);

  const conversationId = chatBody.conversation_id;
  assert(typeof conversationId === "string", "got a real conversation_id");

  console.log("--- A follow-up message on the same conversation never triggers tagging -- compare its latency to the first ---");
  const followUpStart = Date.now();
  const followUpRes = await fetch(`${API_BASE}/api/chat`, {
    method: "POST",
    headers: { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({ message: "Does that tier include priority support?", conversation_id: conversationId }),
  });
  await followUpRes.json();
  const followUpElapsedMs = Date.now() - followUpStart;
  console.log(`  follow-up response returned after ${followUpElapsedMs}ms (no tagging triggered by this one)`);
  assert(followUpRes.status === 200, `follow-up chat request succeeded (got ${followUpRes.status})`);

  // Generous margin -- this is comparing two independent real LLM calls, not a
  // controlled benchmark. The point isn't precision, it's ruling out the specific
  // failure mode of "the first message's response is reliably ~tagging-call-long
  // slower than an ordinary message," which inline-awaited tagging would produce.
  const latencyDeltaMs = responseElapsedMs - followUpElapsedMs;
  console.log(`  latency delta (first-message minus follow-up): ${latencyDeltaMs}ms`);
  assert(latencyDeltaMs < 5000, `the first message (which triggers background tagging) isn't reliably slower than the follow-up by anywhere near a full tagging call's duration (delta ${latencyDeltaMs}ms)`);

  console.log("--- The tag does eventually appear, confirming it really did run (just not on the response's critical path) ---");
  const taggedAt = await (async () => {
    const start = Date.now();
    while (true) {
      const { data } = await service.from("conversation_topics").select("id").eq("conversation_id", conversationId).maybeSingle();
      if (data) return Date.now();
      if (Date.now() - start > 20000) throw new Error("timed out waiting for the background tag to eventually appear");
      await new Promise((r) => setTimeout(r, 300));
    }
  })();
  const taggingLatencyMs = taggedAt - requestStart;
  console.log(`  background tag appeared ${taggingLatencyMs}ms after the request was sent`);

  await service.from("tenants").delete().eq("id", tenant.id);
  console.log("\nALL CHAT-LATENCY-UNAFFECTED-BY-TAGGING CHECKS PASSED");
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
