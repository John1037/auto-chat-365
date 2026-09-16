// Real jsdom-driven checks for the two new UI pieces: widget-settings.html's
// Timezone select (populated, defaults, and saves), and settings.html's Data
// retention section (visible for a real owner, saves via its own dedicated route).
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

async function signUpAndProvision(service, anon, email, password) {
  await service.auth.admin.createUser({ email, password, email_confirm: true });
  const { data: signIn } = await anon.auth.signInWithPassword({ email, password });
  const provisionRes = await fetch(`${API_BASE}/api/tenant-provision`, { method: "POST", headers: { Authorization: `Bearer ${signIn.session.access_token}` } });
  const { tenant, widget } = await provisionRes.json();
  return { signIn, tenant, widget };
}

function authHashFor(session) {
  return `access_token=${session.access_token}&refresh_token=${session.refresh_token}&expires_in=3600&token_type=bearer&type=magiclink`;
}

async function main() {
  const service = createClient(SUPABASE_URL, SERVICE_KEY);
  const anon = createClient(SUPABASE_URL, ANON_KEY);
  const password = "test-password-123!";

  console.log("--- widget-settings.html: Timezone select ---");
  {
    const email = `tz-ui-test-${Date.now()}@example.test`;
    const { signIn, widget } = await signUpAndProvision(service, anon, email, password);

    const settingsHtml = await (await fetch(`${API_BASE}/widget-settings.html`)).text();
    const dom = new JSDOM(settingsHtml, { url: `${API_BASE}/widget-settings.html?id=${widget.id}#${authHashFor(signIn.session)}`, runScripts: "outside-only", resources: "usable" });
    const { window } = dom;
    window.fetch = (url, init) => fetch(new URL(url, API_BASE), init);
    window.eval(readFileSync(new URL("public/widget-settings.js", import.meta.url), "utf8"));

    await new Promise((resolve, reject) => {
      const start = Date.now();
      const check = () => {
        if (window.document.querySelector("#content")?.hidden === false) return resolve();
        if (Date.now() - start > 10000) return reject(new Error("timed out waiting for widget-settings to load"));
        setTimeout(check, 200);
      };
      check();
    });

    const tzSelect = window.document.querySelector("#timezone-input");
    assert(tzSelect.options.length > 100, `the select is populated with a real IANA zone list (got ${tzSelect.options.length} options)`);
    assert(tzSelect.value === "UTC", `defaults to UTC for a brand new widget (got '${tzSelect.value}')`);
    assert([...tzSelect.options].some((o) => o.value === "America/New_York"), "a real, well-known zone is present in the list");

    tzSelect.value = "Australia/Sydney";
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
    const { data: row } = await service.from("widgets").select("timezone").eq("id", widget.id).maybeSingle();
    assert(row.timezone === "Australia/Sydney", `saved timezone persisted (got '${row.timezone}')`);
    window.close();
  }

  console.log("--- settings.html: Data retention section ---");
  {
    const email = `retention-ui-test-${Date.now()}@example.test`;
    const { signIn, tenant } = await signUpAndProvision(service, anon, email, password);

    const settingsHtml = await (await fetch(`${API_BASE}/settings.html`)).text();
    const dom = new JSDOM(settingsHtml, { url: `${API_BASE}/settings.html#${authHashFor(signIn.session)}`, runScripts: "outside-only", resources: "usable" });
    const { window } = dom;
    window.fetch = (url, init) => fetch(new URL(url, API_BASE), init);
    window.eval(readFileSync(new URL("public/settings.js", import.meta.url), "utf8"));

    await new Promise((resolve, reject) => {
      const start = Date.now();
      const check = () => {
        if (window.document.querySelector("#sign-out")) return resolve();
        if (Date.now() - start > 10000) return reject(new Error("timed out waiting for settings page to load"));
        setTimeout(check, 200);
      };
      check();
    });
    await new Promise((r) => setTimeout(r, 500)); // let the async role check + section reveal settle

    const retentionSection = window.document.querySelector("#retention-section");
    const retentionInput = window.document.querySelector("#retention-months-input");
    assert(retentionSection.hidden === false, "the retention section is visible for a real owner");
    assert(retentionInput.value === "13", `defaults to showing 13 months (got '${retentionInput.value}')`);

    retentionInput.value = "6";
    window.document.querySelector("#retention-form").dispatchEvent(new window.Event("submit", { cancelable: true, bubbles: true }));
    await new Promise((resolve, reject) => {
      const start = Date.now();
      const check = () => {
        if (window.document.querySelector("#retention-status")?.textContent === "Saved.") return resolve();
        if (Date.now() - start > 10000) return reject(new Error("timed out waiting for retention save"));
        setTimeout(check, 200);
      };
      check();
    });
    const { data: tenantRow } = await service.from("tenants").select("conversation_retention_months").eq("id", tenant.id).maybeSingle();
    assert(tenantRow.conversation_retention_months === 6, `saved retention persisted (got ${tenantRow.conversation_retention_months})`);
    window.close();
  }

  console.log("\nALL TIMEZONE/RETENTION UI CHECKS PASSED");
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
