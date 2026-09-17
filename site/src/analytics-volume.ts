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

function renderChart(buckets: Bucket[], sums: Map<string, number>): void {
  while (chartSvg.firstChild) chartSvg.removeChild(chartSvg.firstChild);

  const values = buckets.map((b) => sums.get(b.key) ?? 0);
  const max = Math.max(1, ...values);
  const n = Math.max(1, buckets.length);
  const width = Math.max(320, n * 36);
  const innerHeight = CHART_HEIGHT - CHART_PADDING_TOP - CHART_PADDING_BOTTOM;
  const barSlot = width / n;
  const barWidth = Math.max(4, barSlot * 0.6);
  const labelStride = Math.max(1, Math.ceil(n / 14));

  chartSvg.setAttribute("viewBox", `0 0 ${width} ${CHART_HEIGHT}`);
  chartSvg.setAttribute("width", "100%");
  chartSvg.setAttribute("height", String(CHART_HEIGHT));
  chartSvg.setAttribute("preserveAspectRatio", "none");

  const svgNS = "http://www.w3.org/2000/svg";

  buckets.forEach((bucket, i) => {
    const value = values[i];
    const barHeight = max > 0 ? (value / max) * innerHeight : 0;
    const x = i * barSlot + (barSlot - barWidth) / 2;
    const y = CHART_PADDING_TOP + (innerHeight - barHeight);

    const rect = document.createElementNS(svgNS, "rect");
    rect.setAttribute("x", String(x));
    rect.setAttribute("y", String(y));
    rect.setAttribute("width", String(barWidth));
    rect.setAttribute("height", String(Math.max(0, barHeight)));
    rect.setAttribute("class", "volume-bar");
    rect.setAttribute("data-bucket-key", bucket.key);
    rect.setAttribute("data-value", String(value));
    const title = document.createElementNS(svgNS, "title");
    title.textContent = `${bucket.label}: ${value}`;
    rect.appendChild(title);
    chartSvg.appendChild(rect);

    if (i % labelStride === 0) {
      const text = document.createElementNS(svgNS, "text");
      text.setAttribute("x", String(x + barWidth / 2));
      text.setAttribute("y", String(CHART_HEIGHT - 10));
      text.setAttribute("class", "volume-chart-label");
      text.setAttribute("text-anchor", "middle");
      text.textContent = bucket.label;
      chartSvg.appendChild(text);
    }
  });

  const baseline = document.createElementNS(svgNS, "line");
  baseline.setAttribute("x1", "0");
  baseline.setAttribute("x2", String(width));
  baseline.setAttribute("y1", String(CHART_PADDING_TOP + innerHeight));
  baseline.setAttribute("y2", String(CHART_PADDING_TOP + innerHeight));
  baseline.setAttribute("class", "volume-chart-baseline");
  chartSvg.appendChild(baseline);
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

  async function loadAndRender(): Promise<void> {
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

  await loadAndRender();
}

main();
