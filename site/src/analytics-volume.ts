import type { SupabaseClient } from "@supabase/supabase-js";
import { requireSession, wireSignOut, populateSidebarWidgets } from "./authGuard";

interface WidgetOption {
  id: string;
  name: string;
}

interface DailyStatsRow {
  widget_id: string;
  stat_date: string;
  conversations_started: number;
  messages_count: number;
  tool_calls_count: number;
  skill_uses_count: number;
}

type Metric = "conversations_started" | "messages_count" | "tool_calls_count" | "skill_uses_count";
type Period = "day" | "week" | "month";
type Preset = "last7" | "last30" | "last90" | "month_to_date" | "last12months" | "custom";

const METRIC_LABELS: Record<Metric, string> = {
  conversations_started: "Conversations",
  messages_count: "Messages",
  tool_calls_count: "Tool calls",
  skill_uses_count: "Skill uses",
};

const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY_MS = 24 * 60 * 60 * 1000;

interface Ymd {
  y: number;
  m: number; // 0-indexed, matches Date's own convention
  d: number;
}

interface Bucket {
  key: string;
  label: string;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function isoFromYmd(ymd: Ymd): string {
  return `${ymd.y}-${pad2(ymd.m + 1)}-${pad2(ymd.d)}`;
}

function isoToYmd(iso: string): Ymd {
  const [y, m, d] = iso.split("-").map(Number);
  return { y, m: m - 1, d };
}

function ymdToUtcMs(ymd: Ymd): number {
  return Date.UTC(ymd.y, ymd.m, ymd.d);
}

function ymdFromUtcMs(ms: number): Ymd {
  const dt = new Date(ms);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth(), d: dt.getUTCDate() };
}

function shiftMonths(ymd: Ymd, months: number): Ymd {
  return ymdFromUtcMs(Date.UTC(ymd.y, ymd.m + months, ymd.d));
}

function shiftDays(ymd: Ymd, days: number): Ymd {
  return ymdFromUtcMs(ymdToUtcMs(ymd) + days * DAY_MS);
}

// Browser-local "today" -- this is a display filter, not a security- or
// billing-relevant boundary, so it's fine that it doesn't match any one widget's own
// timezone (stat_date itself is already resolved per-widget server-side).
function todayYmd(): Ymd {
  const now = new Date();
  return { y: now.getFullYear(), m: now.getMonth(), d: now.getDate() };
}

function mondayOf(ymd: Ymd): Ymd {
  const dow = new Date(ymdToUtcMs(ymd)).getUTCDay(); // 0=Sun..6=Sat
  const daysSinceMonday = (dow + 6) % 7;
  return shiftDays(ymd, -daysSinceMonday);
}

function monthKey(ymd: Ymd): string {
  return `${ymd.y}-${pad2(ymd.m + 1)}`;
}

function computeRange(preset: Preset, customStart: string, customEnd: string): { start: string; end: string } | null {
  const today = todayYmd();
  const endIso = isoFromYmd(today);

  switch (preset) {
    case "last7":
      return { start: isoFromYmd(shiftDays(today, -6)), end: endIso };
    case "last30":
      return { start: isoFromYmd(shiftDays(today, -29)), end: endIso };
    case "last90":
      return { start: isoFromYmd(shiftDays(today, -89)), end: endIso };
    case "month_to_date":
      return { start: isoFromYmd({ y: today.y, m: today.m, d: 1 }), end: endIso };
    case "last12months": {
      const start = shiftMonths({ y: today.y, m: today.m, d: 1 }, -11);
      return { start: isoFromYmd(start), end: endIso };
    }
    case "custom":
      if (!customStart || !customEnd || customStart > customEnd) return null;
      return { start: customStart, end: customEnd };
  }
}

function buildBuckets(startIso: string, endIso: string, period: Period): Bucket[] {
  const start = isoToYmd(startIso);
  const end = isoToYmd(endIso);
  const endMs = ymdToUtcMs(end);
  const buckets: Bucket[] = [];

  if (period === "day") {
    let cursorMs = ymdToUtcMs(start);
    while (cursorMs <= endMs) {
      const ymd = ymdFromUtcMs(cursorMs);
      buckets.push({ key: isoFromYmd(ymd), label: `${MONTH_ABBR[ymd.m]} ${ymd.d}` });
      cursorMs += DAY_MS;
    }
  } else if (period === "week") {
    let cursorMs = ymdToUtcMs(mondayOf(start));
    while (cursorMs <= endMs) {
      const ymd = ymdFromUtcMs(cursorMs);
      buckets.push({ key: isoFromYmd(ymd), label: `Week of ${MONTH_ABBR[ymd.m]} ${ymd.d}` });
      cursorMs += 7 * DAY_MS;
    }
  } else {
    let cursor: Ymd = { y: start.y, m: start.m, d: 1 };
    const endMonthKey = monthKey(end);
    while (monthKey(cursor) <= endMonthKey) {
      buckets.push({ key: monthKey(cursor), label: `${MONTH_ABBR[cursor.m]} ${cursor.y}` });
      cursor = shiftMonths(cursor, 1);
    }
  }
  return buckets;
}

function bucketKeyForDate(iso: string, period: Period): string {
  const ymd = isoToYmd(iso);
  if (period === "day") return iso;
  if (period === "week") return isoFromYmd(mondayOf(ymd));
  return monthKey(ymd);
}

function sumByBucket(rows: { stat_date: string; value: number }[], buckets: Bucket[], period: Period): Map<string, number> {
  const sums = new Map<string, number>(buckets.map((b) => [b.key, 0]));
  for (const row of rows) {
    const key = bucketKeyForDate(row.stat_date, period);
    if (sums.has(key)) sums.set(key, (sums.get(key) ?? 0) + row.value);
  }
  return sums;
}

const loadingEl = document.querySelector<HTMLElement>("#loading")!;
const errorEl = document.querySelector<HTMLElement>("#error")!;
const emptyEl = document.querySelector<HTMLElement>("#empty-range")!;
const resultsEl = document.querySelector<HTMLElement>("#results")!;

const rangePresetSelect = document.querySelector<HTMLSelectElement>("#range-preset")!;
const customRangeRow = document.querySelector<HTMLElement>("#custom-range-row")!;
const rangeStartInput = document.querySelector<HTMLInputElement>("#range-start")!;
const rangeEndInput = document.querySelector<HTMLInputElement>("#range-end")!;
const periodSelect = document.querySelector<HTMLSelectElement>("#period-select")!;
const metricSelect = document.querySelector<HTMLSelectElement>("#metric-select")!;
const metricHeaderEl = document.querySelector<HTMLElement>("#volume-table-metric-header")!;

const widgetModeAll = document.querySelector<HTMLInputElement>("#widget-mode-all")!;
const widgetModeSelect = document.querySelector<HTMLInputElement>("#widget-mode-select")!;
const widgetChecklist = document.querySelector<HTMLElement>("#widget-checklist")!;
const widgetChecklistEmpty = document.querySelector<HTMLElement>("#widget-checklist-empty")!;

const chartSvg = document.querySelector<SVGSVGElement>("#volume-chart")!;
const tableBody = document.querySelector<HTMLElement>("#volume-table-body")!;
const smoothToggle = document.querySelector<HTMLInputElement>("#smooth-toggle")!;

const CHART_HEIGHT = 220;
const CHART_PADDING_TOP = 16;
const CHART_PADDING_BOTTOM = 34;

function renderTable(buckets: Bucket[], sums: Map<string, number>): void {
  tableBody.innerHTML = "";
  for (const bucket of buckets) {
    const row = document.createElement("tr");
    const labelCell = document.createElement("td");
    labelCell.textContent = bucket.label;
    const valueCell = document.createElement("td");
    valueCell.textContent = String(sums.get(bucket.key) ?? 0);
    row.append(labelCell, valueCell);
    tableBody.appendChild(row);
  }
}

// Always fits the available width, never scrolls -- a year plotted by day needs to
// be readable as one whole shape, not spread across an off-screen strip. viewBox and
// rendered width are always set to the SAME real pixel number (the container's own
// clientWidth), so 1 user unit is always 1 real px regardless of how many periods
// are plotted -- nothing here ever gets stretched or shrunk (that mismatch, via
// width="100%" + preserveAspectRatio="none" on a viewBox sized to bucket count, was
// the earlier bug). A line, not bars, is what makes many-point ranges (e.g. a year
// by day) legible in fixed width: bars that thin than a couple of px wide stop
// reading as bars at all, where a line stays a continuous, readable shape at any
// point density.
const MIN_LABEL_SPACING_PX = 70; // comfortably fits the longest label variant ("Week of Jan 5")
const CHART_PADDING_RIGHT = 8;
const CHART_PADDING_LEFT = 38; // room for the y-axis value labels (0 / 50% / max)
const DEFAULT_CHART_WIDTH_PX = 640; // only used if the container hasn't been laid out yet

// Re-rendered on window resize and on line-style toggle (see main()) so the chart
// keeps fitting its container exactly and switches style without a re-query --
// re-drawn from these already-fetched values.
let lastRenderedChart: { buckets: Bucket[]; sums: Map<string, number> } | null = null;

function formatAxisValue(value: number): string {
  return Math.round(value).toLocaleString();
}

// Standard uniform Catmull-Rom-to-Bezier conversion: a smooth curve that passes
// through every ACTUAL value (no averaging/denoising pass) -- each segment's control
// points are derived from its neighbours so the curve has no sharp corners, but nothing
// here blends a point's value with its neighbours'. A moving average was tried here
// initially and rejected: it necessarily blends a single-day spike into its
// (near-zero) neighbours, so a real event -- e.g. one day of 60 messages surrounded
// by near-zero days -- would get flattened away into a barely-there bump instead of
// staying visible at its true height. "Smooth" only changes curve *style*
// (continuous curvature, no dots) here, never the values themselves.
// Falls back to duplicating the endpoint for the first/last segment, which is the
// usual way to handle a spline having no neighbour beyond the ends.
function buildSmoothPath(points: { x: number; y: number }[]): string {
  if (points.length < 2) return points.length === 1 ? `M ${points[0].x} ${points[0].y}` : "";
  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i === 0 ? 0 : i - 1];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2 < points.length ? i + 2 : i + 1];
    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${p2.x} ${p2.y}`;
  }
  return d;
}

function buildStraightPath(points: { x: number; y: number }[]): string {
  return points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ");
}

function renderChart(buckets: Bucket[], sums: Map<string, number>): void {
  lastRenderedChart = { buckets, sums };
  while (chartSvg.firstChild) chartSvg.removeChild(chartSvg.firstChild);

  const values = buckets.map((b) => sums.get(b.key) ?? 0);
  const max = Math.max(1, ...values);
  const n = Math.max(1, buckets.length);
  const smooth = smoothToggle.checked;

  const width = chartSvg.parentElement?.clientWidth || DEFAULT_CHART_WIDTH_PX;
  const innerLeft = CHART_PADDING_LEFT;
  const innerRight = width - CHART_PADDING_RIGHT;
  const innerWidth = Math.max(1, innerRight - innerLeft);
  const innerHeight = CHART_HEIGHT - CHART_PADDING_TOP - CHART_PADDING_BOTTOM;

  chartSvg.setAttribute("viewBox", `0 0 ${width} ${CHART_HEIGHT}`);
  chartSvg.setAttribute("width", String(width));
  chartSvg.setAttribute("height", String(CHART_HEIGHT));

  const svgNS = "http://www.w3.org/2000/svg";
  const xForIndex = (i: number): number => (n === 1 ? innerLeft + innerWidth / 2 : innerLeft + (i / (n - 1)) * innerWidth);

  // However many labels fit legibly across the available width, spread that many
  // equally-spaced periods' labels across the full range and leave the rest
  // unlabelled -- every period is still plotted on the line regardless.
  const maxLabels = Math.max(2, Math.floor(innerWidth / MIN_LABEL_SPACING_PX) + 1);
  const labelIndexes = new Set<number>();
  if (n <= maxLabels) {
    for (let i = 0; i < n; i++) labelIndexes.add(i);
  } else {
    for (let j = 0; j < maxLabels; j++) labelIndexes.add(Math.round((j * (n - 1)) / (maxLabels - 1)));
  }

  const points = buckets.map((bucket, i) => {
    const value = values[i];
    const y = CHART_PADDING_TOP + innerHeight - (max > 0 ? (value / max) * innerHeight : 0);
    return { x: xForIndex(i), y, value, bucket };
  });

  // Y-axis: zero, half, and max value, each with a faint gridline at its height.
  const yAxisStops = [
    { value: 0, y: CHART_PADDING_TOP + innerHeight },
    { value: max / 2, y: CHART_PADDING_TOP + innerHeight / 2 },
    { value: max, y: CHART_PADDING_TOP },
  ];
  for (const stop of yAxisStops) {
    const gridline = document.createElementNS(svgNS, "line");
    gridline.setAttribute("x1", String(innerLeft));
    gridline.setAttribute("x2", String(innerRight));
    gridline.setAttribute("y1", String(stop.y));
    gridline.setAttribute("y2", String(stop.y));
    gridline.setAttribute("class", "volume-chart-gridline");
    chartSvg.appendChild(gridline);

    const label = document.createElementNS(svgNS, "text");
    label.setAttribute("x", String(innerLeft - 6));
    // Nudge the max/zero labels inward from the gridline itself so their text sits
    // just above/below it rather than being bisected by it.
    label.setAttribute("y", String(stop.value === max ? stop.y + 9 : stop.value === 0 ? stop.y - 3 : stop.y + 3));
    label.setAttribute("class", "volume-chart-axis-label");
    label.setAttribute("text-anchor", "end");
    label.textContent = formatAxisValue(stop.value);
    chartSvg.appendChild(label);
  }

  const path = document.createElementNS(svgNS, "path");
  path.setAttribute("d", smooth ? buildSmoothPath(points) : buildStraightPath(points));
  path.setAttribute("class", "volume-line");
  chartSvg.appendChild(path);

  points.forEach((p, i) => {
    // Exact mode plots every point as a dot; smooth mode shows only the curve, per
    // the toggle's own definition -- the points aren't hidden data, they're still
    // fully present in the underlying table and in the curve's own shape.
    if (!smooth) {
      const dot = document.createElementNS(svgNS, "circle");
      dot.setAttribute("cx", String(p.x));
      dot.setAttribute("cy", String(p.y));
      dot.setAttribute("r", "3");
      dot.setAttribute("class", "volume-dot");
      dot.setAttribute("data-bucket-key", p.bucket.key);
      dot.setAttribute("data-value", String(p.value));
      const title = document.createElementNS(svgNS, "title");
      title.textContent = `${p.bucket.label}: ${p.value}`;
      dot.appendChild(title);
      chartSvg.appendChild(dot);
    }

    if (labelIndexes.has(i)) {
      const text = document.createElementNS(svgNS, "text");
      text.setAttribute("x", String(p.x));
      text.setAttribute("y", String(CHART_HEIGHT - 10));
      text.setAttribute("class", "volume-chart-label");
      // The first/last labels anchor outward (start/end) instead of centering, so
      // they extend inward from the chart's edge rather than overflowing past it.
      text.setAttribute("text-anchor", i === 0 ? "start" : i === n - 1 ? "end" : "middle");
      text.textContent = p.bucket.label;
      chartSvg.appendChild(text);
    }
  });
}

function renderWidgetChecklist(widgets: WidgetOption[], onChange: () => void): void {
  if (widgets.length === 0) {
    widgetChecklistEmpty.hidden = false;
    return;
  }
  for (const widget of widgets) {
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = widget.id;
    input.checked = true;
    input.addEventListener("change", onChange);
    label.append(input, document.createTextNode(` ${widget.name}`));
    widgetChecklist.appendChild(label);
  }
}

function getSelectedWidgetIds(): string[] | null {
  if (widgetModeAll.checked) return null;
  return Array.from(widgetChecklist.querySelectorAll<HTMLInputElement>('input[type="checkbox"]:checked')).map((cb) => cb.value);
}

async function main() {
  const context = await requireSession();
  if (!context) return; // already redirected to /login.html
  wireSignOut();
  populateSidebarWidgets(context.supabase);
  const supabase: SupabaseClient = context.supabase;

  // Guards against out-of-order responses: two filter changes made in quick
  // succession (e.g. switching widget mode then immediately unchecking a widget)
  // fire two overlapping queries, and network timing offers no guarantee the first
  // one resolves first. Without this, a slower, now-stale response could overwrite
  // the newer filter's already-rendered result.
  let requestSeq = 0;

  async function loadAndRender(): Promise<void> {
    const seq = ++requestSeq;
    loadingEl.hidden = false;
    errorEl.hidden = true;
    emptyEl.hidden = true;
    resultsEl.hidden = true;

    const preset = rangePresetSelect.value as Preset;
    customRangeRow.hidden = preset !== "custom";
    const range = computeRange(preset, rangeStartInput.value, rangeEndInput.value);
    if (!range) {
      loadingEl.hidden = true;
      emptyEl.hidden = false;
      emptyEl.textContent = "Pick a valid start and end date.";
      return;
    }

    const period = periodSelect.value as Period;
    const metric = metricSelect.value as Metric;
    metricHeaderEl.textContent = METRIC_LABELS[metric];

    const widgetIds = getSelectedWidgetIds();
    if (widgetIds !== null && widgetIds.length === 0) {
      loadingEl.hidden = true;
      emptyEl.hidden = false;
      emptyEl.textContent = "Select at least one widget.";
      return;
    }

    let query = supabase
      .from("widget_daily_stats")
      .select("widget_id, stat_date, conversations_started, messages_count, tool_calls_count, skill_uses_count")
      .gte("stat_date", range.start)
      .lte("stat_date", range.end);
    if (widgetIds !== null) query = query.in("widget_id", widgetIds);

    const { data, error } = await query;
    if (seq !== requestSeq) return; // a newer filter change superseded this request
    loadingEl.hidden = true;

    if (error) {
      errorEl.hidden = false;
      return;
    }

    const rows = (data as DailyStatsRow[] | null) ?? [];
    const buckets = buildBuckets(range.start, range.end, period);
    const sums = sumByBucket(rows.map((r) => ({ stat_date: r.stat_date, value: r[metric] })), buckets, period);

    resultsEl.hidden = false;
    renderTable(buckets, sums);
    renderChart(buckets, sums);
  }

  const { data: widgetsData, error: widgetsError } = await supabase
    .from("widgets")
    .select("id, name")
    .order("created_at", { ascending: true });

  if (widgetsError) {
    loadingEl.hidden = true;
    errorEl.hidden = false;
    return;
  }

  renderWidgetChecklist((widgetsData as WidgetOption[] | null) ?? [], loadAndRender);

  rangePresetSelect.addEventListener("change", loadAndRender);
  periodSelect.addEventListener("change", loadAndRender);
  metricSelect.addEventListener("change", loadAndRender);
  rangeStartInput.addEventListener("change", loadAndRender);
  rangeEndInput.addEventListener("change", loadAndRender);
  widgetModeAll.addEventListener("change", () => {
    widgetChecklist.hidden = true;
    loadAndRender();
  });
  widgetModeSelect.addEventListener("change", () => {
    widgetChecklist.hidden = false;
    loadAndRender();
  });

  smoothToggle.addEventListener("change", () => {
    if (lastRenderedChart) renderChart(lastRenderedChart.buckets, lastRenderedChart.sums);
  });

  let resizeTimer: ReturnType<typeof setTimeout> | undefined;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (lastRenderedChart) renderChart(lastRenderedChart.buckets, lastRenderedChart.sums);
    }, 150);
  });

  await loadAndRender();
}

main();
