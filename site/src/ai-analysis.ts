import type { SupabaseClient } from "@supabase/supabase-js";
import { requireSession, wireSignOut, populateSidebarWidgets, getAccessToken } from "./authGuard";
import { type Preset, computeRange } from "./dateRange";

interface WidgetOption {
  id: string;
  name: string;
}

interface AnalysisResponse {
  answer?: string;
  conversations_considered?: number;
  topics_considered?: number;
  error?: string;
}

const rangePresetSelect = document.querySelector<HTMLSelectElement>("#range-preset")!;
const customRangeRow = document.querySelector<HTMLElement>("#custom-range-row")!;
const rangeStartInput = document.querySelector<HTMLInputElement>("#range-start")!;
const rangeEndInput = document.querySelector<HTMLInputElement>("#range-end")!;
const widgetSelect = document.querySelector<HTMLSelectElement>("#widget-select")!;

const queryForm = document.querySelector<HTMLFormElement>("#query-form")!;
const queryInput = document.querySelector<HTMLTextAreaElement>("#query-input")!;
const analyzeButton = document.querySelector<HTMLButtonElement>("#analyze-button")!;
const queryStatusEl = document.querySelector<HTMLElement>("#query-status")!;

const answerWrapEl = document.querySelector<HTMLElement>("#answer-wrap")!;
const answerTextEl = document.querySelector<HTMLElement>("#answer-text")!;
const answerMetaEl = document.querySelector<HTMLElement>("#answer-meta")!;

function populateWidgetSelect(widgets: WidgetOption[]): void {
  for (const widget of widgets) {
    const option = document.createElement("option");
    option.value = widget.id;
    option.textContent = widget.name;
    widgetSelect.appendChild(option);
  }
}

async function main() {
  const context = await requireSession();
  if (!context) return; // already redirected to /login.html
  wireSignOut();
  populateSidebarWidgets(context.supabase);
  const supabase: SupabaseClient = context.supabase;

  rangePresetSelect.addEventListener("change", () => {
    customRangeRow.hidden = rangePresetSelect.value !== "custom";
  });

  const { data: widgetsData } = await supabase
    .from("widgets")
    .select("id, name")
    .order("created_at", { ascending: true });
  populateWidgetSelect((widgetsData as WidgetOption[] | null) ?? []);

  queryForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const preset = rangePresetSelect.value as Preset;
    customRangeRow.hidden = preset !== "custom";
    const range = computeRange(preset, rangeStartInput.value, rangeEndInput.value);
    if (!range) {
      queryStatusEl.textContent = "Pick a valid start and end date.";
      queryStatusEl.classList.add("error");
      return;
    }

    const query = queryInput.value.trim();
    if (!query) return;

    analyzeButton.disabled = true;
    queryInput.disabled = true;
    queryStatusEl.textContent = "Analyzing...";
    queryStatusEl.classList.remove("error");
    answerWrapEl.hidden = true;

    try {
      const accessToken = await getAccessToken(supabase);
      if (!accessToken) throw new Error("Your session has expired. Please sign in again.");
      const response = await fetch("/api/ai-analysis", {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          query,
          range_start: range.start,
          range_end: range.end,
          widget_id: widgetSelect.value,
        }),
      });
      const responseBody = (await response.json().catch(() => ({}))) as AnalysisResponse;
      if (!response.ok) {
        throw new Error(responseBody.error || `analysis failed (${response.status})`);
      }

      answerTextEl.textContent = responseBody.answer ?? "";
      const conversationsConsidered = responseBody.conversations_considered ?? 0;
      const topicsConsidered = responseBody.topics_considered ?? 0;
      answerMetaEl.textContent =
        conversationsConsidered > 0
          ? `Based on ${conversationsConsidered} tagged conversation${conversationsConsidered === 1 ? "" : "s"} across ${topicsConsidered} topic${topicsConsidered === 1 ? "" : "s"}.`
          : "";
      answerWrapEl.hidden = false;
      queryStatusEl.textContent = "";
    } catch (err) {
      queryStatusEl.textContent = err instanceof Error ? err.message : "Something went wrong running that analysis.";
      queryStatusEl.classList.add("error");
    } finally {
      analyzeButton.disabled = false;
      queryInput.disabled = false;
    }
  });
}

main();
