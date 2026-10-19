// Regression test for a real production bug: a tenant on response_length='normal'
// got a reply truncated mid-sentence on an open-ended advice-style question (not a
// simple FAQ lookup) -- the old max_tokens cap (160) was calibrated against narrow
// FAQ-style test questions and was too tight for a nuanced, multi-clause answer.
// The widget has to work for any tenant's site/topic, so this deliberately tests
// several UNRELATED domains (home improvement, nutrition, personal finance, pets) --
// not the reported career-advice topic -- each phrased to invite the same
// recommendation-plus-caveats-plus-exception shape that caused the original cutoff.
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SERVICE_KEY = process.env.SUPABASE_SECRET_KEY;
const API_BASE = "http://127.0.0.1:8787";
const ORIGIN = "https://truncation-fix-test.example";

function assert(cond, msg) {
  if (!cond) throw new Error("ASSERTION FAILED: " + msg);
  console.log("  ok:", msg);
}

// Ends with sentence-terminating punctuation (or a closing quote/paren after one) --
// the actual, durable signal of "this reply wasn't cut off mid-thought," regardless
// of exact length.
function endsCleanly(text) {
  return /[.!?]['"”)]?\s*$/.test(text.trim());
}

async function chatOnce(accessToken, message) {
  const res = await fetch(`${API_BASE}/api/chat`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({ message }),
  });
  return res.json();
}

async function main() {
  const service = createClient(SUPABASE_URL, SERVICE_KEY);
  const { data: tenant } = await service.from("tenants").insert({ name: `Truncation Fix Test ${Date.now()}` }).select("id").single();
  const { data: widget } = await service
    .from("widgets")
    .insert({ tenant_id: tenant.id, allowed_origins: [ORIGIN], response_length: "normal" })
    .select("id, site_key")
    .single();

  const questions = [
    "Should I replace my old gas boiler with a heat pump, even though I'm not sure it's a great fit for my house?",
    "Is it worth cutting out all sugar from my diet, or is that overkill for someone who's generally healthy?",
    "Should I put my savings into index funds even though I don't know much about investing?",
    "Is it a bad idea to adopt a high-energy dog breed if I live in a small apartment?",
  ];

  for (const question of questions) {
    const startRes = await fetch(`${API_BASE}/api/session-start`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN },
      body: JSON.stringify({ site_key: widget.site_key }),
    });
    const { access_token } = await startRes.json();
    const result = await chatOnce(access_token, question);
    console.log(`\nQ: ${question}`);
    console.log(`A: ${result.reply}`);
    assert(typeof result.reply === "string" && result.reply.length > 0, "got a real, non-empty reply");
    assert(endsCleanly(result.reply), `reply ends on a complete sentence, not mid-clause (ends: "...${result.reply.slice(-40)}")`);
  }

  await service.from("tenants").delete().eq("id", tenant.id);
  console.log("\nALL TRUNCATION FIX CHECKS PASSED");
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
