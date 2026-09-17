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

async function main() {
  const service = createClient(SUPABASE_URL, SERVICE_KEY);
  const anon = createClient(SUPABASE_URL, ANON_KEY);
  const password = "test-password-123!";
  const email = `chart-visual-${Date.now()}@example.test`;
  await service.auth.admin.createUser({ email, password, email_confirm: true });
  const { data: signIn } = await anon.auth.signInWithPassword({ email, password });
  const provisionRes = await fetch(`${API_BASE}/api/tenant-provision`, { method: "POST", headers: { Authorization: `Bearer ${signIn.session.access_token}` } });
  const { tenant, widget } = await provisionRes.json();

  // Seed 400 days of data so "last 12 months / day" has plenty of real buckets,
  // and also seed within the last 90 days for the "90 days / month" few-bucket case.
  const rows = [];
  for (let i = 0; i < 400; i++) {
    rows.push({ widget_id: widget.id, tenant_id: tenant.id, stat_date: isoDaysAgo(i), conversations_started: 1 + (i % 7), messages_count: 3 + (i % 11) });
  }
  await service.from("widget_daily_stats").insert(rows);

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  // The shipped CSP's connect-src is scoped to https://*.supabase.co (production);
  // local dev's Supabase is http://127.0.0.1:54321, so it gets blocked here the same
  // way test-security-headers.mjs already documented -- strip the header for this
  // local-only visual check rather than touching the real, production-verified policy.
  await page.route("**/*", async (route) => {
    const response = await route.fetch();
    const headers = response.headers();
    delete headers["content-security-policy"];
    route.fulfill({ response, headers });
  });
  const hash = `access_token=${signIn.session.access_token}&refresh_token=${signIn.session.refresh_token}&expires_in=3600&token_type=bearer&type=magiclink`;
  await page.goto(`${API_BASE}/analytics-volume.html#${hash}`);
  await page.waitForSelector("#results:not([hidden])", { timeout: 10000 });

  async function measure(label) {
    // font-size of the first rendered label, spacing between consecutive labels
    // (the actual readability metric for a scrollable chart -- total label count
    // across the whole scrollable width isn't, since only ~one viewport's worth is
    // ever visible at once), and total svg width vs container width.
    const info = await page.evaluate(() => {
      const svg = document.querySelector("#volume-chart");
      const labels = Array.from(svg.querySelectorAll("text.volume-chart-label"));
      const rects = labels.map((t) => t.getBoundingClientRect());
      const gaps = rects.slice(1).map((r, i) => r.x - rects[i].x);
      const container = document.querySelector(".chart-wrap");
      return {
        svgWidthAttr: svg.getAttribute("width"),
        labelCount: labels.length,
        barCount: svg.querySelectorAll("rect.volume-bar").length,
        firstLabelHeightPx: rects[0].height,
        minGapBetweenLabelsPx: gaps.length ? Math.min(...gaps) : null,
        labelsPerViewport: container.clientWidth / (gaps[0] ?? container.clientWidth),
        containerClientWidth: container.clientWidth,
        containerScrollWidth: container.scrollWidth,
      };
    });
    console.log(label, JSON.stringify(info));
    return info;
  }

  console.log("--- Few buckets: 90 days / month period (3-4 buckets) ---");
  await page.selectOption("#range-preset", "last90");
  await page.selectOption("#period-select", "month");
  await page.waitForTimeout(800);
  const fewBucketsInfo = await measure("few-buckets");

  console.log("--- Many buckets: 12 months / day period (~365 buckets) ---");
  await page.selectOption("#range-preset", "last12months");
  await page.selectOption("#period-select", "day");
  await page.waitForTimeout(800);
  const manyBucketsInfo = await measure("many-buckets");

  const heightDiff = Math.abs(fewBucketsInfo.firstLabelHeightPx - manyBucketsInfo.firstLabelHeightPx);
  console.log(`\nLabel height few=${fewBucketsInfo.firstLabelHeightPx.toFixed(2)}px many=${manyBucketsInfo.firstLabelHeightPx.toFixed(2)}px diff=${heightDiff.toFixed(2)}px`);
  if (heightDiff > 1) throw new Error("Label text size differs meaningfully between few-bucket and many-bucket views -- distortion bug not fixed");
  if (manyBucketsInfo.containerScrollWidth <= manyBucketsInfo.containerClientWidth) throw new Error("Many-bucket chart didn't grow wider than its container -- horizontal scroll won't kick in");
  if (manyBucketsInfo.minGapBetweenLabelsPx < 55) throw new Error(`Labels are packed too tightly in the many-bucket view (min gap ${manyBucketsInfo.minGapBetweenLabelsPx}px) -- would overlap/be unreadable`);
  if (manyBucketsInfo.labelsPerViewport > 20) throw new Error(`Too many labels visible within one viewport width (${manyBucketsInfo.labelsPerViewport.toFixed(1)}) -- stride logic isn't thinning them enough`);
  console.log(`\nLabels per viewport: few=${fewBucketsInfo.labelsPerViewport?.toFixed(1) ?? "n/a"} many=${manyBucketsInfo.labelsPerViewport.toFixed(1)}`);
  console.log("CHART SIZE/DISTORTION CHECKS PASSED");

  await browser.close();
  await service.from("tenants").delete().eq("id", tenant.id);
}
main().catch((e) => { console.error("FAILED:", e); process.exit(1); });
