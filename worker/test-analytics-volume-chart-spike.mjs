// Regression test for a real bug report: with 7 daily points [0,8,0,60,8,0,0], the
// smooth-mode curve's moving-average pass blended the single-day spike (60) into its
// near-zero neighbours, rendering a peak of only ~23 -- failing to represent what
// actually happened. Smooth mode must run a curve through the ACTUAL values (only the
// curve *style* differs from exact mode, never the data), so the spike's true height
// must be visible on the chart regardless of line style.
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SERVICE_KEY = process.env.SUPABASE_SECRET_KEY;
const ANON_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;
const API_BASE = "http://127.0.0.1:8787";

function isoDaysAgo(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

function assert(cond, msg) {
  if (!cond) throw new Error("ASSERTION FAILED: " + msg);
  console.log("  ok:", msg);
}

// The smooth path's Bezier segments always end exactly at a real data point's (x, y)
// -- extract those endpoints (the "C ..., ..., x y" tail of each segment, plus the
// initial "M x y") to read back what height the curve is actually reaching.
function endpointYsFromPath(d) {
  const commands = d.split(/(?=[ML]|C)/).map((s) => s.trim()).filter(Boolean);
  const ys = [];
  for (const cmd of commands) {
    const nums = cmd.replace(/^[MLC]\s*/, "").split(",").map((part) => part.trim().split(/\s+/).map(Number));
    const last = nums[nums.length - 1];
    ys.push(last[1]);
  }
  return ys;
}

async function main() {
  const service = createClient(SUPABASE_URL, SERVICE_KEY);
  const anon = createClient(SUPABASE_URL, ANON_KEY);
  const password = "test-password-123!";
  const email = `chart-spike-${Date.now()}@example.test`;
  await service.auth.admin.createUser({ email, password, email_confirm: true });
  const { data: signIn } = await anon.auth.signInWithPassword({ email, password });
  const provisionRes = await fetch(`${API_BASE}/api/tenant-provision`, { method: "POST", headers: { Authorization: `Bearer ${signIn.session.access_token}` } });
  const { tenant, widget } = await provisionRes.json();

  // Exactly the reported case: 7 days, messages_count = [0,8,0,60,8,0,0].
  const messageCounts = [0, 8, 0, 60, 8, 0, 0];
  const rows = messageCounts.map((count, i) => ({
    widget_id: widget.id,
    tenant_id: tenant.id,
    stat_date: isoDaysAgo(6 - i),
    conversations_started: 0,
    messages_count: count,
  }));
  await service.from("widget_daily_stats").insert(rows);

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  await page.route("**/*", async (route) => {
    const response = await route.fetch();
    const headers = response.headers();
    delete headers["content-security-policy"];
    route.fulfill({ response, headers });
  });
  const hash = `access_token=${signIn.session.access_token}&refresh_token=${signIn.session.refresh_token}&expires_in=3600&token_type=bearer&type=magiclink`;
  await page.goto(`${API_BASE}/analytics-volume.html#${hash}`);
  await page.waitForSelector("#results:not([hidden])", { timeout: 10000 });

  await page.selectOption("#range-preset", "last7");
  await page.selectOption("#period-select", "day");
  await page.selectOption("#metric-select", "messages_count");
  await page.waitForTimeout(500);

  const smoothChecked = await page.$eval("#smooth-toggle", (el) => el.checked);
  assert(smoothChecked, "smooth mode is the default for this check");

  const { d, axisLabels } = await page.evaluate(() => {
    const svg = document.querySelector("#volume-chart");
    return {
      d: svg.querySelector("path.volume-line").getAttribute("d"),
      axisLabels: Array.from(svg.querySelectorAll("text.volume-chart-axis-label")).map((t) => t.textContent),
    };
  });

  assert(axisLabels.includes("60"), `y-axis max label reflects the real spike value, 60 (got ${JSON.stringify(axisLabels)})`);

  const ys = endpointYsFromPath(d);
  assert(ys.length === 7, `curve has exactly 7 on-curve points, one per day (got ${ys.length})`);

  // y-coordinates run top(=max)-to-bottom(=0) in SVG space -- the spike (index 3,
  // value 60 = the series max) must land at the very top of the plotted area, not
  // partway down from a blended/averaged value.
  const spikeY = ys[3];
  const minY = Math.min(...ys);
  assert(Math.abs(spikeY - minY) < 0.5, `the spike point sits at the curve's actual highest point, unblended (spikeY=${spikeY.toFixed(2)}, topY=${minY.toFixed(2)})`);

  // The zero-value neighbours must stay at the true zero/baseline height too, not
  // dragged upward by an averaging pass that blended in the spike.
  const baselineY = Math.max(...ys);
  for (const i of [0, 2, 5, 6]) {
    assert(Math.abs(ys[i] - baselineY) < 0.5, `day ${i} (a real zero) stays at the baseline, not pulled up toward the spike (y=${ys[i].toFixed(2)}, baseline=${baselineY.toFixed(2)})`);
  }

  console.log("\nALL SPIKE-PRESERVATION CHECKS PASSED");

  await browser.close();
  await service.from("tenants").delete().eq("id", tenant.id);
}
main().catch((e) => { console.error("FAILED:", e); process.exit(1); });
