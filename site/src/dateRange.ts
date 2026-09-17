// Shared date-range preset resolution, used by both analytics-volume.ts and
// ai-analysis.ts so the two pages' "Last 7 days"/"Last 30 days"/etc. presets always
// mean exactly the same thing.
export type Preset = "last7" | "last30" | "last90" | "month_to_date" | "last12months" | "custom";

export interface Ymd {
  y: number;
  m: number; // 0-indexed, matches Date's own convention
  d: number;
}

export const DAY_MS = 24 * 60 * 60 * 1000;

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export function isoFromYmd(ymd: Ymd): string {
  return `${ymd.y}-${pad2(ymd.m + 1)}-${pad2(ymd.d)}`;
}

export function isoToYmd(iso: string): Ymd {
  const [y, m, d] = iso.split("-").map(Number);
  return { y, m: m - 1, d };
}

export function ymdToUtcMs(ymd: Ymd): number {
  return Date.UTC(ymd.y, ymd.m, ymd.d);
}

export function ymdFromUtcMs(ms: number): Ymd {
  const dt = new Date(ms);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth(), d: dt.getUTCDate() };
}

export function shiftMonths(ymd: Ymd, months: number): Ymd {
  return ymdFromUtcMs(Date.UTC(ymd.y, ymd.m + months, ymd.d));
}

export function shiftDays(ymd: Ymd, days: number): Ymd {
  return ymdFromUtcMs(ymdToUtcMs(ymd) + days * DAY_MS);
}

// Browser-local "today" -- this is a display filter, not a security- or
// billing-relevant boundary, so it's fine that it doesn't match any one widget's own
// timezone (server-side data is already resolved per-widget there).
export function todayYmd(): Ymd {
  const now = new Date();
  return { y: now.getFullYear(), m: now.getMonth(), d: now.getDate() };
}

export function computeRange(preset: Preset, customStart: string, customEnd: string): { start: string; end: string } | null {
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
