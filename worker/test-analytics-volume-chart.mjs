// Real Playwright check for the Analytics > Volume chart: it must always fit the
// available width (no horizontal scrollbar, whether plotting 4 periods or 365),
// plot every period regardless of count, and label only as many equally-spaced
// periods as fit legibly. Also covers the exact/smooth line-style toggle (default
// smooth, no dots -- switching to exact draws a dot per point and a straight-segment
// path), the y-axis labels (0 / 50% / max), and the data table starting collapsed.
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
  // Values are never all equal, so max > 0 and the 50%/max y-axis labels are meaningful.
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

  async function measure() {
    return page.evaluate(() => {
      const svg = document.querySelector("#volume-chart");
      const labels = Array.from(svg.querySelectorAll("text.volume-chart-label"));
      const rects = labels.map((t) => t.getBoundingClientRect());
      const sortedRects = [...rects].sort((a, b) => a.x - b.x);
      const gaps = sortedRects.slice(1).map((r, i) => r.x - sortedRects[i].x);
      const container = document.querySelector(".chart-wrap");
      const path = svg.querySelector("path.volume-line");
      const axisLabels = Array.from(svg.querySelectorAll("text.volume-chart-axis-label")).map((t) => t.textContent);
      return {
        svgWidthAttr: Number(svg.getAttribute("width")),
        dotCount: svg.querySelectorAll("circle.volume-dot").length,
        hasLine: !!path,
        pathUsesCurve: path?.getAttribute("d")?.includes("C") ?? false,
        labelCount: labels.length,
        firstLabelHeightPx: rects[0]?.height ?? null,
        minGapBetweenLabelsPx: gaps.length ? Math.min(...gaps) : null,
        containerClientWidth: container.clientWidth,
        containerScrollWidth: container.scrollWidth,
        axisLabels,
      };
    });
  }

  console.log("--- Default state: smooth toggle checked, no dots, curved path, 3 y-axis labels ---");
  {
    const smoothChecked = await page.$eval("#smooth-toggle", (el) => el.checked);
    assert(smoothChecked, "the smooth/exact toggle defaults to checked (smooth)");
    const info = await measure();
    console.log("  " + JSON.stringify(info));
    assert(info.hasLine, "a line path is drawn by default");
    assert(info.dotCount === 0, `no per-point dots are drawn in the default smooth mode (got ${info.dotCount})`);
    assert(info.pathUsesCurve, "the default path uses curve (C) commands, not just straight segments");
    assert(info.axisLabels.length === 3, `y-axis shows exactly 3 labels: zero, 50%, and max (got ${JSON.stringify(info.axisLabels)})`);
    assert(info.axisLabels[0] === "0", `first y-axis label is zero (got '${info.axisLabels[0]}')`);
  }

  console.log("--- Switching to 'Exact': dots appear, path becomes straight-segment ---");
  await page.click(".toggle-switch-row"); // unchecks the smooth toggle
  await page.waitForTimeout(200);
  {
    const smoothChecked = await page.$eval("#smooth-toggle", (el) => el.checked);
    assert(!smoothChecked, "toggle is now unchecked (exact)");
    const info = await measure();
    assert(info.dotCount > 0, `exact mode draws a dot per plotted point (got ${info.dotCount})`);
    assert(!info.pathUsesCurve, "exact mode's path uses only straight (M/L) segments, no curves");
  }

  console.log("--- Data table starts collapsed, opens on click ---");
  {
    const details = page.locator("#volume-table-details");
    assert(!(await details.evaluate((el) => el.open)), "the data table <details> starts closed by default");
    const rowsVisibleBeforeOpen = await page.locator("#volume-table-body tr").first().isVisible();
    assert(!rowsVisibleBeforeOpen, "table rows are not visible while the details element is collapsed");
    await page.click("#volume-table-details summary");
    await page.waitForTimeout(100);
    assert(await details.evaluate((el) => el.open), "clicking the summary opens the details element");
    const rowsVisibleAfterOpen = await page.locator("#volume-table-body tr").first().isVisible();
    assert(rowsVisibleAfterOpen, "table rows become visible once opened");
  }

  console.log("--- Few periods: 90 days / month period (3-4 points), back in exact mode ---");
  await page.selectOption("#range-preset", "last90");
  await page.selectOption("#period-select", "month");
  await page.waitForTimeout(500);
  const few = await measure();
  console.log("  " + JSON.stringify(few));

  console.log("--- Many periods: 12 months / day period (~350+ points) ---");
  await page.selectOption("#range-preset", "last12months");
  await page.selectOption("#period-select", "day");
  await page.waitForTimeout(500);
  const many = await measure();
  console.log("  " + JSON.stringify(many));

  assert(few.hasLine && many.hasLine, "a line is drawn in both the few- and many-period views");
  assert(few.svgWidthAttr === few.containerClientWidth, `few-period chart width exactly matches its container (${few.svgWidthAttr} vs ${few.containerClientWidth})`);
  assert(many.svgWidthAttr === many.containerClientWidth, `many-period chart width exactly matches its container (${many.svgWidthAttr} vs ${many.containerClientWidth})`);
  assert(few.containerScrollWidth === few.containerClientWidth, "few-period view never needs to scroll horizontally");
  assert(many.containerScrollWidth === many.containerClientWidth, `many-period view (${many.dotCount} points) never needs to scroll horizontally either`);

  assert(few.dotCount >= 3 && few.dotCount <= 5, `few-period view plots one point per month bucket (got ${few.dotCount})`);
  assert(many.dotCount > 340, `many-period view plots every single day as a point, none dropped (got ${many.dotCount})`);

  assert(few.labelCount === few.dotCount, `with few periods, every one gets its own label (got ${few.labelCount} labels for ${few.dotCount} points)`);
  assert(many.labelCount < many.dotCount, `with many periods, not every one gets a label (got ${many.labelCount} labels for ${many.dotCount} points)`);
  assert(many.labelCount >= 2 && many.labelCount <= 15, `many-period view still shows a reasonable, evenly-spaced number of labels (got ${many.labelCount})`);

  const heightDiff = Math.abs(few.firstLabelHeightPx - many.firstLabelHeightPx);
  assert(heightDiff <= 1, `label text renders at the same real size regardless of period count (few=${few.firstLabelHeightPx}px many=${many.firstLabelHeightPx}px)`);
  assert(many.minGapBetweenLabelsPx >= 55, `labels stay legibly spaced even with many periods selected (min gap ${many.minGapBetweenLabelsPx}px)`);

  assert(many.axisLabels.length === 3, `y-axis still shows exactly 3 labels in the many-period view (got ${JSON.stringify(many.axisLabels)})`);

  console.log("\nALL CHART FEATURE CHECKS PASSED");

  await browser.close();
  await service.from("tenants").delete().eq("id", tenant.id);
}
main().catch((e) => { console.error("FAILED:", e); process.exit(1); });
