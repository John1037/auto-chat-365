// Real end-to-end verification of the real-time daily-stats counters: sends real
// chat messages that trigger each specific event (a blocked topic, a rate limit
// hit, and an ordinary successful reply), then confirms widget_daily_stats picked
// each one up correctly -- proving the increments actually fire from chat.ts, not
// just that the SQL function itself is correct in isolation.
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SERVICE_KEY = process.env.SUPABASE_SECRET_KEY;
const API_BASE = "http://127.0.0.1:8787";
const ORIGIN = "https://daily-stats-test.example";

function assert(cond, msg) {
  if (!cond) throw new Error("ASSERTION FAILED: " + msg);
  console.log("  ok:", msg);
}

async function chatAs(widget) {
  const startRes = await fetch(`${API_BASE}/api/session-start`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({ site_key: widget.site_key }),
  });
  const { access_token } = await startRes.json();
  return async (message) => {
    const res = await fetch(`${API_BASE}/api/chat`, {
      method: "POST",
      headers: { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json", Origin: ORIGIN },
      body: JSON.stringify({ message }),
    });
    return { status: res.status, body: await res.json() };
  };
}

async function getTodayStats(service, widgetId) {
  const { data } = await service.from("widget_daily_stats").select("*").eq("widget_id", widgetId).order("stat_date", { ascending: false }).limit(1).maybeSingle();
  return data;
}

async function main() {
  const service = createClient(SUPABASE_URL, SERVICE_KEY);

  console.log("--- A blocked-topic refusal increments guardrail_blocked_topic_count and guardrail_refusals_count ---");
  {
    const { data: tenant } = await service.from("tenants").insert({ name: "Daily Stats Test A" }).select("id").single();
    const { data: widget } = await service.from("widgets").insert({ tenant_id: tenant.id, allowed_origins: [ORIGIN], blocked_topics: ["competitor pricing"] }).select("id, site_key").single();
    const send = await chatAs(widget);
    const { status } = await send("What about your competitor pricing?");
    assert(status === 200, "chat call succeeded (with a refusal reply)");
    const stats = await getTodayStats(service, widget.id);
    console.log("  stats row:", JSON.stringify(stats));
    assert(stats.guardrail_blocked_topic_count === 1, `guardrail_blocked_topic_count is 1 (got ${stats.guardrail_blocked_topic_count})`);
    assert(stats.guardrail_refusals_count === 1, `guardrail_refusals_count is 1 (got ${stats.guardrail_refusals_count})`);
    assert(stats.guardrail_injection_count === 0, "guardrail_injection_count stayed 0 (not the reason this was blocked)");
    await service.from("tenants").delete().eq("id", tenant.id);
  }

  console.log("--- A rate-limit hit increments rate_limit_hit_count, with no conversation created ---");
  {
    const { data: tenant } = await service.from("tenants").insert({ name: "Daily Stats Test B" }).select("id").single();
    const { data: widget } = await service.from("widgets").insert({ tenant_id: tenant.id, allowed_origins: [ORIGIN], rate_limit_per_minute: 1 }).select("id, site_key").single();
    const send = await chatAs(widget);
    await send("first message, consumes the only slot"); // succeeds, uses up the limit of 1/minute
    const { status } = await send("second message, should be rate limited");
    assert(status === 429, `second message was rate limited (${status})`);
    const stats = await getTodayStats(service, widget.id);
    console.log("  stats row:", JSON.stringify(stats));
    assert(stats.rate_limit_hit_count === 1, `rate_limit_hit_count is 1 (got ${stats.rate_limit_hit_count})`);
    await service.from("tenants").delete().eq("id", tenant.id);
  }

  console.log("--- An ordinary successful reply increments latency_sample_count, not any guardrail counter ---");
  {
    const { data: tenant } = await service.from("tenants").insert({ name: "Daily Stats Test C" }).select("id").single();
    const { data: widget } = await service.from("widgets").insert({ tenant_id: tenant.id, allowed_origins: [ORIGIN] }).select("id, site_key").single();
    const send = await chatAs(widget);
    const { status } = await send("What are your opening hours?");
    assert(status === 200, "ordinary chat call succeeded");
    const stats = await getTodayStats(service, widget.id);
    console.log("  stats row:", JSON.stringify(stats));
    assert(stats.latency_sample_count === 1, `latency_sample_count is 1 (got ${stats.latency_sample_count})`);
    assert(stats.latency_sum_ms > 0, `latency_sum_ms recorded a real positive value (got ${stats.latency_sum_ms})`);
    assert(stats.guardrail_refusals_count === 0, "no guardrail counters incremented for an ordinary message");
    assert(stats.rate_limit_hit_count === 0, "no rate-limit counter incremented for an ordinary message");
    await service.from("tenants").delete().eq("id", tenant.id);
  }

  console.log("\nALL REAL-TIME DAILY STATS CHECKS PASSED");
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
