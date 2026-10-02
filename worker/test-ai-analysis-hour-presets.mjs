// Real check of the new "last 1 hour"/"last 6 hours"/"today"/"yesterday" presets:
// an hour-old topic tag should be included by "last 6 hours" and excluded by
// "last 1 hour"; a tag from 30 hours ago should show up under "yesterday" but not
// "today".
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SERVICE_KEY = process.env.SUPABASE_SECRET_KEY;
const ANON_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;
const API_BASE = "http://127.0.0.1:8787";

function assert(cond, msg) {
  if (!cond) throw new Error("ASSERTION FAILED: " + msg);
  console.log("  ok:", msg);
}

function hoursAgo(h) {
  return new Date(Date.now() - h * 60 * 60 * 1000).toISOString();
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
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function main() {
  const service = createClient(SUPABASE_URL, SERVICE_KEY);
  const anon = createClient(SUPABASE_URL, ANON_KEY);
  const password = "test-password-123!";
  const email = `hour-presets-${Date.now()}@example.test`;
  const { signIn, tenant, widget } = await signUpAndProvision(service, anon, email, password);
  const accessToken = signIn.session.access_token;

  const threeHoursAgo = hoursAgo(3);
  const thirtyHoursAgo = hoursAgo(30);

  await service.from("conversation_topics").insert([
    { tenant_id: tenant.id, widget_id: widget.id, conversation_date: threeHoursAgo.slice(0, 10), conversation_started_at: threeHoursAgo, topic_label: "Recent topic", summary: "Happened 3 hours ago." },
    { tenant_id: tenant.id, widget_id: widget.id, conversation_date: thirtyHoursAgo.slice(0, 10), conversation_started_at: thirtyHoursAgo, topic_label: "Older topic", summary: "Happened 30 hours ago." },
  ]);

  console.log("--- last_6_hours includes the 3-hours-ago row ---");
  {
    const start = hoursAgo(6);
    const { status, body } = await analyze(accessToken, { query: "What happened recently?", range_start: start, range_end: new Date().toISOString(), widget_id: "all" });
    assert(status === 200, `request succeeds (got ${status})`);
    assert(body.conversations_considered === 1, `only the 3-hours-ago row is in range (got ${body.conversations_considered})`);
  }

  console.log("--- last_1_hour excludes the 3-hours-ago row entirely (zero data) ---");
  {
    const start = hoursAgo(1);
    const { status, body } = await analyze(accessToken, { query: "What happened in the last hour?", range_start: start, range_end: new Date().toISOString(), widget_id: "all" });
    assert(status === 200, `request succeeds (got ${status})`);
    assert(body.conversations_considered === 0, `the 3-hours-ago row falls outside a 1-hour window (got ${body.conversations_considered})`);
  }

  console.log("--- yesterday-shaped range (24-36h ago) includes the 30-hours-ago row, not the 3-hours-ago one ---");
  {
    const start = hoursAgo(36);
    const end = hoursAgo(24);
    const { status, body } = await analyze(accessToken, { query: "What came up yesterday?", range_start: start, range_end: end, widget_id: "all" });
    assert(status === 200, `request succeeds (got ${status})`);
    assert(body.conversations_considered === 1, `only the 30-hours-ago row falls in a 24-36h-ago window (got ${body.conversations_considered})`);
  }

  await service.from("tenants").delete().eq("id", tenant.id);
  console.log("\nALL HOUR-LEVEL PRESET RANGE CHECKS PASSED");
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
