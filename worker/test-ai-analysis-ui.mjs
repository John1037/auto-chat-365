// Real jsdom-driven check of the AI Analysis page itself (not just the API route,
// which test-ai-analysis.mjs already covers thoroughly): the widget dropdown
// populates, the custom-range row toggles, and submitting the form actually wires
// through to /api/ai-analysis and renders the real answer.
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

async function main() {
  const service = createClient(SUPABASE_URL, SERVICE_KEY);
  const anon = createClient(SUPABASE_URL, ANON_KEY);
  const password = "test-password-123!";
  const email = `ai-analysis-ui-${Date.now()}@example.test`;
  await service.auth.admin.createUser({ email, password, email_confirm: true });
  const { data: signIn } = await anon.auth.signInWithPassword({ email, password });
  const provisionRes = await fetch(`${API_BASE}/api/tenant-provision`, { method: "POST", headers: { Authorization: `Bearer ${signIn.session.access_token}` } });
  const { tenant, widget } = await provisionRes.json();

  const today = new Date().toISOString().slice(0, 10);
  await service.from("conversation_topics").insert({
    tenant_id: tenant.id,
    widget_id: widget.id,
    conversation_date: today,
    topic_label: "Shipping questions",
    summary: "Asked when their order would arrive.",
  });

  const html = await (await fetch(`${API_BASE}/ai-analysis.html`)).text();
  const dom = new JSDOM(html, { url: `${API_BASE}/ai-analysis.html#${authHashFor(signIn.session)}`, runScripts: "outside-only", resources: "usable" });
  const { window } = dom;
  window.fetch = (url, init) => fetch(new URL(url, API_BASE), init);
  window.eval(readFileSync(new URL("public/ai-analysis.js", import.meta.url), "utf8"));

  await new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (window.document.querySelector("#sign-out")) return resolve();
      if (Date.now() - start > 10000) return reject(new Error("timed out waiting for page to load"));
      setTimeout(check, 200);
    };
    check();
  });
  await new Promise((r) => setTimeout(r, 500)); // let the async widget-select population settle

  console.log("--- Widget dropdown populates with the real widget ---");
  const widgetSelect = window.document.querySelector("#widget-select");
  const optionLabels = Array.from(widgetSelect.options).map((o) => o.textContent.trim());
  assert(optionLabels.includes("All widgets"), "the 'All widgets' option is present");
  assert(optionLabels.some((l) => l === widget.name), `the real widget's name is present (got ${JSON.stringify(optionLabels)})`);

  console.log("--- Custom range row is hidden by default, shown when 'Custom range' is selected ---");
  const customRangeRow = window.document.querySelector("#custom-range-row");
  assert(customRangeRow.hidden === true, "custom range row starts hidden");
  const rangePreset = window.document.querySelector("#range-preset");
  rangePreset.value = "custom";
  rangePreset.dispatchEvent(new window.Event("change", { bubbles: true }));
  assert(customRangeRow.hidden === false, "custom range row appears once 'Custom range' is selected");
  rangePreset.value = "last7";
  rangePreset.dispatchEvent(new window.Event("change", { bubbles: true }));

  console.log("--- Submitting the form calls the real API and renders the real answer ---");
  const queryInput = window.document.querySelector("#query-input");
  queryInput.value = "What were customers asking about?";
  const form = window.document.querySelector("#query-form");
  form.dispatchEvent(new window.Event("submit", { cancelable: true, bubbles: true }));

  await new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (window.document.querySelector("#answer-wrap")?.hidden === false) return resolve();
      if (Date.now() - start > 20000) return reject(new Error("timed out waiting for the answer to render"));
      setTimeout(check, 300);
    };
    check();
  });

  const answerText = window.document.querySelector("#answer-text").textContent;
  const answerMeta = window.document.querySelector("#answer-meta").textContent;
  console.log("  answer:", answerText);
  console.log("  meta:", answerMeta);
  assert(answerText.length > 0, "a real, non-empty answer is rendered");
  assert(answerMeta.includes("1 tagged conversation"), `the meta line reflects the real considered count (got "${answerMeta}")`);
  assert(window.document.querySelector("#analyze-button").disabled === false, "the Analyze button is re-enabled after completion");

  window.close();
  await service.from("tenants").delete().eq("id", tenant.id);
  console.log("\nALL AI ANALYSIS UI CHECKS PASSED");
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
