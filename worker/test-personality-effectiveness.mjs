// Confirms the Personality settings actually change what the real chat model
// produces -- not just that the prompt string looks right. The reported bug was
// that 'enthusiastic' read identical to 'helpful' and 'concise' still came out
// verbose; this checks real, measurable differences (word count for length, marker
// words for tone) against the live chat provider (DeepSeek, with automatic OpenAI
// fallback -- whichever actually answers, this exercises the real production path).
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SERVICE_KEY = process.env.SUPABASE_SECRET_KEY;
const API_BASE = "http://127.0.0.1:8787";
const ORIGIN = "https://personality-effectiveness-test.example";
const QUESTION = "What are your opening hours?";

function assert(cond, msg) {
  if (!cond) throw new Error("ASSERTION FAILED: " + msg);
  console.log("  ok:", msg);
}

function wordCount(text) {
  return text.trim().split(/\s+/).length;
}

async function askAs(service, personality) {
  const { data: tenant } = await service.from("tenants").insert({ name: `Personality Effectiveness ${personality.character_style}` }).select("id").single();
  const { data: widget } = await service
    .from("widgets")
    .insert({ tenant_id: tenant.id, allowed_origins: [ORIGIN], ...personality })
    .select("site_key")
    .single();

  const startRes = await fetch(`${API_BASE}/api/session-start`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({ site_key: widget.site_key }),
  });
  const { access_token } = await startRes.json();
  const chatRes = await fetch(`${API_BASE}/api/chat`, {
    method: "POST",
    headers: { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({ message: QUESTION }),
  });
  const { reply } = await chatRes.json();
  await service.from("tenants").delete().eq("id", tenant.id);
  return reply;
}

async function main() {
  const service = createClient(SUPABASE_URL, SERVICE_KEY);

  console.log("--- Length: terse vs verbose, same question ---");
  const terseReply = await askAs(service, { character_style: "helpful", response_style: "balanced", response_length: "terse" });
  console.log(`  terse (${wordCount(terseReply)} words): ${terseReply}`);
  const verboseReply = await askAs(service, { character_style: "helpful", response_style: "balanced", response_length: "verbose" });
  console.log(`  verbose (${wordCount(verboseReply)} words): ${verboseReply}`);
  assert(wordCount(terseReply) <= 25, `terse reply is actually short (${wordCount(terseReply)} words)`);
  assert(wordCount(verboseReply) > wordCount(terseReply) * 2, `verbose reply is meaningfully longer than terse (${wordCount(verboseReply)} vs ${wordCount(terseReply)} words)`);

  console.log("--- Tone: enthusiastic vs informative, same question ---");
  const enthusiasticReply = await askAs(service, { character_style: "enthusiastic", response_style: "balanced", response_length: "concise" });
  console.log(`  enthusiastic: ${enthusiasticReply}`);
  const informativeReply = await askAs(service, { character_style: "informative", response_style: "balanced", response_length: "concise" });
  console.log(`  informative: ${informativeReply}`);
  const enthusiasmMarkers = (enthusiasticReply.match(/!/g) || []).length;
  const informativeMarkers = (informativeReply.match(/!/g) || []).length;
  assert(enthusiasmMarkers > informativeMarkers, `enthusiastic reply reads more energetically than informative (${enthusiasmMarkers} vs ${informativeMarkers} exclamation marks)`);

  console.log("\nALL PERSONALITY EFFECTIVENESS CHECKS PASSED");
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
