// Real-world test: DeepSeek is genuinely degraded right now (confirmed via their
// own status page and direct API calls all session), so a real /api/chat call
// through the actual deployed code should exercise the OpenAI fallback for real,
// not a simulated one.
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SERVICE_KEY = process.env.SUPABASE_SECRET_KEY;
const API_BASE = "http://127.0.0.1:8787";
const ORIGIN = "https://chat-fallback-test.example";

function assert(cond, msg) {
  if (!cond) throw new Error("ASSERTION FAILED: " + msg);
  console.log("  ok:", msg);
}

async function main() {
  const service = createClient(SUPABASE_URL, SERVICE_KEY);
  const { data: tenant } = await service.from("tenants").insert({ name: "Chat Fallback Test" }).select("id").single();
  const { data: widget } = await service
    .from("widgets")
    .insert({ tenant_id: tenant.id, allowed_origins: [ORIGIN] })
    .select("id, site_key")
    .single();

  const startRes = await fetch(`${API_BASE}/api/session-start`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({ site_key: widget.site_key }),
  });
  const session = await startRes.json();

  console.log("Sending a real chat message (timing it, since a timeout+fallback should take ~20s if DeepSeek hangs)...");
  const start = Date.now();
  const chatRes = await fetch(`${API_BASE}/api/chat`, {
    method: "POST",
    headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({ message: "Say hello in exactly one word." }),
  });
  const elapsed = Date.now() - start;
  const body = await chatRes.json();
  console.log(`  status: ${chatRes.status}, elapsed: ${elapsed}ms`);
  console.log("  body:", body);

  assert(chatRes.status === 200, `chat request succeeded (${chatRes.status})`);
  assert(typeof body.reply === "string" && body.reply.length > 0, "got a real, non-empty reply");
  assert(elapsed < 30000, `resolved within the expected timeout+fallback window (took ${elapsed}ms)`);

  const { data: savedMessage } = await service.from("messages").select("content").eq("id", body.message_id).single();
  assert(savedMessage.content === body.reply, "the reply was actually persisted to the messages table");

  await service.from("tenants").delete().eq("id", tenant.id);
  console.log("\nALL CHAT FALLBACK CHECKS PASSED");
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
