// Confirms the dashboard's widget-settings.html form loads and saves the new
// Guardrails section (between Appearance and Access) -- same technique as
// test-widget-personality-form.mjs.
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

async function main() {
  const admin = createClient(SUPABASE_URL, SERVICE_KEY);
  const email = `guardrails-form-test-${Date.now()}@example.test`;
  const password = "test-password-123!";
  const { error: createErr } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (createErr) throw createErr;

  const anon = createClient(SUPABASE_URL, ANON_KEY);
  const { data: signIn } = await anon.auth.signInWithPassword({ email, password });
  const accessToken = signIn.session.access_token;

  await fetch(`${API_BASE}/api/tenant-provision`, { method: "POST", headers: { Authorization: `Bearer ${accessToken}` } });
  const { widget } = await (
    await fetch(`${API_BASE}/api/create-widget`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Guardrails Form Test" }),
    })
  ).json();

  const authHash =
    `access_token=${signIn.session.access_token}&refresh_token=${signIn.session.refresh_token}` +
    `&expires_in=3600&token_type=bearer&type=magiclink`;
  const settingsHtml = await (await fetch(`${API_BASE}/widget-settings.html`)).text();
  const dom = new JSDOM(settingsHtml, {
    url: `${API_BASE}/widget-settings.html?id=${widget.id}#${authHash}`,
    runScripts: "outside-only",
    resources: "usable",
  });
  const { window } = dom;
  window.fetch = (url, init) => fetch(new URL(url, API_BASE), init);
  window.eval(readFileSync(new URL("public/widget-settings.js", import.meta.url), "utf8"));

  await new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (window.document.querySelector("#content")?.hidden === false) return resolve();
      if (Date.now() - start > 10000) return reject(new Error("timed out waiting for settings form"));
      setTimeout(check, 200);
    };
    check();
  });

  console.log("--- Section placement ---");
  const legends = [...window.document.querySelectorAll(".settings-section legend")].map((l) => l.textContent);
  console.log("  sections:", legends);
  assert(
    legends.indexOf("Appearance") < legends.indexOf("Guardrails") && legends.indexOf("Guardrails") < legends.indexOf("Access"),
    `Guardrails sits between Appearance and Access (got order: ${legends.join(", ")})`,
  );

  console.log("--- Defaults ---");
  const profanitySelect = window.document.querySelector("#profanity-policy-input");
  const offTopicSelect = window.document.querySelector("#off-topic-policy-input");
  const blockedTopicsArea = window.document.querySelector("#blocked-topics-input");
  assert(profanitySelect.value === "warn", `default profanity_policy shows 'warn' (got '${profanitySelect.value}')`);
  assert(offTopicSelect.value === "allow", `default off_topic_policy shows 'allow' (got '${offTopicSelect.value}')`);
  assert(blockedTopicsArea.value === "", "blocked_topics starts empty");

  console.log("--- Save round trip ---");
  profanitySelect.value = "refuse";
  offTopicSelect.value = "strict";
  blockedTopicsArea.value = "competitor pricing\nmedical advice";
  window.document.querySelector("#settings-form").dispatchEvent(new window.Event("submit", { cancelable: true, bubbles: true }));

  await new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (window.document.querySelector("#save-status")?.textContent === "Saved.") return resolve();
      if (Date.now() - start > 10000) return reject(new Error("timed out waiting for save"));
      setTimeout(check, 200);
    };
    check();
  });

  const service = createClient(SUPABASE_URL, SERVICE_KEY);
  const { data: row } = await service.from("widgets").select("profanity_policy, off_topic_policy, blocked_topics").eq("id", widget.id).maybeSingle();
  assert(row.profanity_policy === "refuse", `saved profanity_policy persisted (got '${row.profanity_policy}')`);
  assert(row.off_topic_policy === "strict", `saved off_topic_policy persisted (got '${row.off_topic_policy}')`);
  assert(
    JSON.stringify(row.blocked_topics) === JSON.stringify(["competitor pricing", "medical advice"]),
    `saved blocked_topics persisted (got ${JSON.stringify(row.blocked_topics)})`,
  );

  console.log("\nALL GUARDRAILS SETTINGS FORM CHECKS PASSED");
  window.close();
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
