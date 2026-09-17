// Real end-to-end verification of the /api/ai-analysis route: grouping/bounding
// logic against seeded conversation_topics rows (no need to re-run the real tagging
// pipeline here, that's covered by test-conversation-tagging.mjs), input validation,
// auth, cross-tenant isolation, and rate limiting -- against a real wrangler dev +
// local Supabase, with a real final LLM call for the actual analysis answer.
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SERVICE_KEY = process.env.SUPABASE_SECRET_KEY;
const ANON_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;
const API_BASE = "http://127.0.0.1:8787";

function assert(cond, msg) {
  if (!cond) throw new Error("ASSERTION FAILED: " + msg);
  console.log("  ok:", msg);
}

function isoDaysAgo(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

async function signUpAndProvision(service, anon, email, password) {
  await service.auth.admin.createUser({ email, password, email_confirm: true });
  const { data: signIn } = await anon.auth.signInWithPassword({ email, password });
  const provisionRes = await fetch(`${API_BASE}/api/tenant-provision`, { method: "POST", headers: { Authorization: `Bearer ${signIn.session.access_token}` } });
  const { tenant, widget } = await provisionRes.json();
  return { signIn, tenant, widget };
}

async function analyze(accessToken, payload) {
  const res = await fetch(`${API_BASE}/api/ai-analysis`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function main() {
  const service = createClient(SUPABASE_URL, SERVICE_KEY);
  const anon = createClient(SUPABASE_URL, ANON_KEY);
  const password = "test-password-123!";

  console.log("--- Seed tenant A: two widgets with known topic tags, across today and yesterday ---");
  const emailA = `ai-analysis-a-${Date.now()}@example.test`;
  const { signIn: signInA, tenant: tenantA, widget: widgetA1 } = await signUpAndProvision(service, anon, emailA, password);
  const { data: widgetA2 } = await service.from("widgets").insert({ tenant_id: tenantA.id, name: "Second widget" }).select("id").single();
  const accessTokenA = signInA.session.access_token;

  const today = isoDaysAgo(0);
  const yesterday = isoDaysAgo(1);
  const longAgo = isoDaysAgo(400); // well outside any range we'll query -- must never be counted

  await service.from("conversation_topics").insert([
    { tenant_id: tenantA.id, widget_id: widgetA1.id, conversation_date: today, topic_label: "Pricing questions", summary: "Asked about enterprise pricing." },
    { tenant_id: tenantA.id, widget_id: widgetA1.id, conversation_date: today, topic_label: "Pricing questions", summary: "Wanted a discount for annual billing." },
    { tenant_id: tenantA.id, widget_id: widgetA1.id, conversation_date: yesterday, topic_label: "Login issues", summary: "Couldn't reset their password." },
    { tenant_id: tenantA.id, widget_id: widgetA2.id, conversation_date: today, topic_label: "Refund requests", summary: "Wanted a refund for a duplicate charge." },
    { tenant_id: tenantA.id, widget_id: widgetA1.id, conversation_date: longAgo, topic_label: "Ancient topic", summary: "This is far outside the query range." },
  ]);

  console.log("--- Seed tenant B: unrelated topic tag, must never leak into A's analysis ---");
  const emailB = `ai-analysis-b-${Date.now()}@example.test`;
  const { signIn: signInB, tenant: tenantB, widget: widgetB } = await signUpAndProvision(service, anon, emailB, password);
  await service.from("conversation_topics").insert({ tenant_id: tenantB.id, widget_id: widgetB.id, conversation_date: today, topic_label: "Tenant B secret topic", summary: "Should never appear in tenant A's results." });

  console.log("--- All widgets, range covering today+yesterday: sees 4 of tenant A's rows, 3 distinct topics ---");
  {
    const { status, body } = await analyze(accessTokenA, { query: "What were customers asking about?", range_start: yesterday, range_end: today, widget_id: "all" });
    assert(status === 200, `request succeeds (got ${status}, ${JSON.stringify(body)})`);
    assert(body.conversations_considered === 4, `sums to exactly the 4 in-range rows across both widgets (got ${body.conversations_considered})`);
    assert(body.topics_considered === 3, `groups down to 3 distinct topics: Pricing questions, Login issues, Refund requests (got ${body.topics_considered})`);
    assert(typeof body.answer === "string" && body.answer.length > 0, "a real written answer is returned");
    console.log("  answer:", body.answer);
  }

  console.log("--- Scoped to widget 2 only: sees just its own single row ---");
  {
    const { status, body } = await analyze(accessTokenA, { query: "What is this widget's traffic about?", range_start: yesterday, range_end: today, widget_id: widgetA2.id });
    assert(status === 200, "request succeeds");
    assert(body.conversations_considered === 1, `only widget 2's own row counts (got ${body.conversations_considered})`);
  }

  console.log("--- Range with no tagged data yet: friendly message, no LLM call needed, zero counts ---");
  {
    const { status, body } = await analyze(accessTokenA, { query: "Anything interesting?", range_start: isoDaysAgo(200), range_end: isoDaysAgo(150), widget_id: "all" });
    assert(status === 200, "request still succeeds");
    assert(body.conversations_considered === 0, "zero conversations considered for an empty range");
    assert(typeof body.answer === "string" && body.answer.length > 0, "a friendly explanatory answer is still returned");
  }

  console.log("--- Validation: missing query, overlong query, bad dates, inverted range ---");
  {
    const missingQuery = await analyze(accessTokenA, { range_start: yesterday, range_end: today, widget_id: "all" });
    assert(missingQuery.status === 400, `missing query is rejected (got ${missingQuery.status})`);

    const overlong = await analyze(accessTokenA, { query: "x".repeat(501), range_start: yesterday, range_end: today, widget_id: "all" });
    assert(overlong.status === 400, `a 501-character query is rejected (got ${overlong.status})`);

    const badDate = await analyze(accessTokenA, { query: "test", range_start: "not-a-date", range_end: today, widget_id: "all" });
    assert(badDate.status === 400, `a malformed date is rejected (got ${badDate.status})`);

    const invertedRange = await analyze(accessTokenA, { query: "test", range_start: today, range_end: yesterday, widget_id: "all" });
    assert(invertedRange.status === 400, `range_start after range_end is rejected (got ${invertedRange.status})`);
  }

  console.log("--- Auth: no token is rejected; tenant A cannot use tenant B's widget_id ---");
  {
    const res = await fetch(`${API_BASE}/api/ai-analysis`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "test", range_start: yesterday, range_end: today, widget_id: "all" }),
    });
    assert(res.status === 401, `an unauthenticated request is rejected (got ${res.status})`);

    const { status } = await analyze(accessTokenA, { query: "test", range_start: yesterday, range_end: today, widget_id: widgetB.id });
    assert(status === 403, `tenant A cannot scope a query to tenant B's widget_id (got ${status})`);
  }

  console.log("--- Cross-tenant isolation: tenant B's own analysis never sees tenant A's topics ---");
  {
    const { status, body } = await analyze(signInB.session.access_token, { query: "What are people asking about?", range_start: yesterday, range_end: today, widget_id: "all" });
    assert(status === 200, "tenant B's own request succeeds");
    assert(body.conversations_considered === 1, `tenant B sees only its own single seeded row (got ${body.conversations_considered})`);
  }

  console.log("--- Rate limiting: pre-filling the counter (no LLM calls needed) then one real request is blocked ---");
  {
    for (let i = 0; i < 20; i++) {
      await service.rpc("check_and_increment_rate_limit", {
        p_tenant_id: tenantA.id,
        p_scope: "tenant",
        p_scope_key: `ai-analysis:${tenantA.id}`,
        p_window_seconds: 3600,
        p_limit: 20,
      });
    }
    const { status } = await analyze(accessTokenA, { query: "one more", range_start: yesterday, range_end: today, widget_id: "all" });
    assert(status === 429, `the 21st request within the window is rate-limited (got ${status})`);
  }

  await service.from("tenants").delete().eq("id", tenantA.id);
  await service.from("tenants").delete().eq("id", tenantB.id);
  console.log("\nALL AI ANALYSIS CHECKS PASSED");
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
