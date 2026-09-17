// Real jsdom-driven checks for the new Analytics > Volume page: filters (date range
// preset, display period bucketing, metric selection, widget scoping) computed
// against real seeded widget_daily_stats rows, plus real cross-tenant RLS isolation
// (no mocking -- the page talks to local Supabase exactly as production would).
import { createClient } from "@supabase/supabase-js";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SERVICE_KEY = process.env.SUPABASE_SECRET_KEY;
const ANON_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;
const API_BASE = "http://127.0.0.1:8787";

function assert(cond, msg) {
  if (!cond) throw new Error("ASSERTION FAILED: " + msg);
  console.log("  ok:", msg);
}

function authHashFor(session) {
  return `access_token=${session.access_token}&refresh_token=${session.refresh_token}&expires_in=3600&token_type=bearer&type=magiclink`;
}

async function signUpAndProvision(service, anon, email, password) {
  await service.auth.admin.createUser({ email, password, email_confirm: true });
  const { data: signIn } = await anon.auth.signInWithPassword({ email, password });
  const provisionRes = await fetch(`${API_BASE}/api/tenant-provision`, { method: "POST", headers: { Authorization: `Bearer ${signIn.session.access_token}` } });
  const { tenant, widget } = await provisionRes.json();
  return { signIn, tenant, widget };
}

function isoDaysAgo(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

async function openAnalyticsPage(session, widgetId) {
  const html = await (await fetch(`${API_BASE}/analytics-volume.html`)).text();
  const dom = new JSDOM(html, { url: `${API_BASE}/analytics-volume.html#${authHashFor(session)}`, runScripts: "outside-only", resources: "usable" });
  const { window } = dom;
  window.fetch = (url, init) => fetch(new URL(url, API_BASE), init);
  window.eval(readFileSync(new URL("public/analytics-volume.js", import.meta.url), "utf8"));

  await new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (window.document.querySelector("#results")?.hidden === false) return resolve();
      if (window.document.querySelector("#error")?.hidden === false) return reject(new Error("page reported an error while loading"));
      if (Date.now() - start > 10000) return reject(new Error("timed out waiting for analytics page to load"));
      setTimeout(check, 200);
    };
    check();
  });
  return window;
}

function tableRows(window) {
  return Array.from(window.document.querySelectorAll("#volume-table-body tr")).map((tr) => {
    const [label, value] = Array.from(tr.querySelectorAll("td")).map((td) => td.textContent);
    return { label, value: Number(value) };
  });
}

async function waitFor(window, predicate, message) {
  await new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > 10000) return reject(new Error(`timed out waiting for: ${message}`));
      setTimeout(check, 200);
    };
    check();
  });
}

async function main() {
  const service = createClient(SUPABASE_URL, SERVICE_KEY);
  const anon = createClient(SUPABASE_URL, ANON_KEY);
  const password = "test-password-123!";

  console.log("--- Seed tenant A: two widgets with known daily stats ---");
  const emailA = `analytics-vol-a-${Date.now()}@example.test`;
  const { signIn: signInA, tenant: tenantA, widget: widgetA1 } = await signUpAndProvision(service, anon, emailA, password);
  const { data: widgetA2 } = await service.from("widgets").insert({ tenant_id: tenantA.id, name: "Second widget" }).select("id, tenant_id").single();

  const d0 = isoDaysAgo(0);
  const d1 = isoDaysAgo(1);
  const d2 = isoDaysAgo(2);

  await service.from("widget_daily_stats").insert([
    { widget_id: widgetA1.id, tenant_id: tenantA.id, stat_date: d0, conversations_started: 5, messages_count: 20 },
    { widget_id: widgetA1.id, tenant_id: tenantA.id, stat_date: d1, conversations_started: 3, messages_count: 9 },
    { widget_id: widgetA1.id, tenant_id: tenantA.id, stat_date: d2, conversations_started: 2, messages_count: 6 },
    { widget_id: widgetA2.id, tenant_id: tenantA.id, stat_date: d0, conversations_started: 10, messages_count: 40 },
  ]);

  console.log("--- Seed tenant B: unrelated widget + stats, must never leak into A's totals ---");
  const emailB = `analytics-vol-b-${Date.now()}@example.test`;
  const { widget: widgetB, tenant: tenantB } = await signUpAndProvision(service, anon, emailB, password);
  await service.from("widget_daily_stats").insert({ widget_id: widgetB.id, tenant_id: tenantB.id, stat_date: d0, conversations_started: 999, messages_count: 999 });

  console.log("--- Page loads for tenant A, default filters (last 30 days / day / conversations, all widgets) ---");
  {
    const window = await openAnalyticsPage(signInA.session, widgetA1.id);
    const widgetOptionLabels = Array.from(window.document.querySelectorAll("#widget-select option")).map((o) => o.textContent.trim());
    assert(widgetOptionLabels.length === 3, `dropdown offers 'All widgets' plus both of tenant A's widgets (got ${JSON.stringify(widgetOptionLabels)})`);
    assert(widgetOptionLabels[0] === "All widgets", "the dropdown's first option is 'All widgets'");
    assert(widgetOptionLabels.includes("Default widget") && widgetOptionLabels.includes("Second widget"), `both real widget names are present (got ${JSON.stringify(widgetOptionLabels)})`);

    const rows = tableRows(window);
    const row0 = rows.find((r) => r.label.includes(new Date(d0).toLocaleString("en-US", { month: "short" })) || true);
    const total = rows.reduce((sum, r) => sum + r.value, 0);
    assert(total === 5 + 3 + 2 + 10, `default metric (Conversations) sums both of tenant A's widgets across all seeded days, excluding tenant B (got ${total})`);
    assert(!rows.some((r) => r.value === 999), "tenant B's 999-conversation row never appears in tenant A's chart");

    console.log("--- Switch metric to Messages ---");
    const metricSelect = window.document.querySelector("#metric-select");
    metricSelect.value = "messages_count";
    metricSelect.dispatchEvent(new window.Event("change", { bubbles: true }));
    await waitFor(window, () => tableRows(window).reduce((s, r) => s + r.value, 0) === 20 + 9 + 6 + 40, "messages total updates to 75");
    assert(true, "messages metric sums to 75 across both widgets");

    console.log("--- Select widget 1 specifically from the dropdown -- totals should narrow to just that widget ---");
    const widgetSelect = window.document.querySelector("#widget-select");
    widgetSelect.value = widgetA1.id;
    widgetSelect.dispatchEvent(new window.Event("change", { bubbles: true }));
    await waitFor(window, () => tableRows(window).reduce((s, r) => s + r.value, 0) === 20 + 9 + 6, "messages total narrows to widget 1 alone (35)");
    assert(true, "selecting an individual widget correctly excludes the other widget's rows");

    console.log("--- Select widget 2 specifically -- totals should narrow to just ITS rows ---");
    widgetSelect.value = widgetA2.id;
    widgetSelect.dispatchEvent(new window.Event("change", { bubbles: true }));
    await waitFor(window, () => tableRows(window).reduce((s, r) => s + r.value, 0) === 40, "messages total narrows to widget 2 alone (40)");
    assert(true, "switching the dropdown to the other widget shows only its own rows");

    console.log("--- Back to 'All widgets' -- total should return to the combined 75 ---");
    widgetSelect.value = "all";
    widgetSelect.dispatchEvent(new window.Event("change", { bubbles: true }));
    await waitFor(window, () => tableRows(window).reduce((s, r) => s + r.value, 0) === 75, "messages total returns to the combined 75");
    assert(true, "switching back to 'All widgets' restores the combined total");

    window.close();
  }

  console.log("--- Week bucketing: 3 seeded days should collapse into fewer buckets than 'day' mode ---");
  {
    const window = await openAnalyticsPage(signInA.session, widgetA1.id);
    const periodSelect = window.document.querySelector("#period-select");
    periodSelect.value = "week";
    periodSelect.dispatchEvent(new window.Event("change", { bubbles: true }));
    await waitFor(window, () => tableRows(window).some((r) => r.label.startsWith("Week of")), "week-bucketed table renders");
    const weekRows = tableRows(window);
    const weekTotal = weekRows.reduce((s, r) => s + r.value, 0);
    assert(weekTotal === 5 + 3 + 2 + 10, `week bucketing preserves the same overall total as day bucketing (got ${weekTotal})`);
    assert(weekRows.some((r) => r.label.startsWith("Week of")), "week bucket labels use the 'Week of ...' format");
    window.close();
  }

  console.log("--- Cross-tenant isolation: tenant B's own session never sees tenant A's widgets or stats ---");
  {
    const emailB2 = `analytics-vol-b2-${Date.now()}@example.test`;
    await service.auth.admin.createUser({ email: emailB2, password, email_confirm: true });
    // Reuse tenant B's own owner session instead -- signed in above as emailB.
    const { data: signInB } = await anon.auth.signInWithPassword({ email: emailB, password });
    const window = await openAnalyticsPage(signInB.session, widgetB.id);
    const widgetOptionLabels = Array.from(window.document.querySelectorAll("#widget-select option")).map((o) => o.textContent.trim());
    assert(widgetOptionLabels.length === 2, `tenant B's dropdown offers only 'All widgets' plus its own single widget (got ${JSON.stringify(widgetOptionLabels)})`);
    const total = tableRows(window).reduce((s, r) => s + r.value, 0);
    assert(total === 999, `tenant B sees its own real 999-conversation row, and nothing from tenant A (got ${total})`);
    window.close();
  }

  await service.from("tenants").delete().eq("id", tenantA.id);
  await service.from("tenants").delete().eq("id", tenantB.id);
  console.log("\nALL ANALYTICS VOLUME CHECKS PASSED");
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
