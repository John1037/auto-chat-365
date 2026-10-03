// Verifies the icon/window size sliders: default (0%) renders the base pixel sizes,
// each dial scales only its own element (launcher+its svg, or the panel) and the two
// are independent, and the saved percentage actually reaches the real bundled
// widget.js output -- same eval-the-real-bundle technique as test-widget-theme.mjs.
import { createClient } from "@supabase/supabase-js";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SERVICE_KEY = process.env.SUPABASE_SECRET_KEY;
const API_BASE = "http://127.0.0.1:8787";
const ORIGIN = "https://size-test.example";

function assert(cond, msg) {
  if (!cond) throw new Error("ASSERTION FAILED: " + msg);
  console.log("  ok:", msg);
}

async function renderWidget(siteKey) {
  const dom = new JSDOM(
    `<!doctype html><html><body><script src="${API_BASE}/widget.js" data-site-key="${siteKey}"></script></body></html>`,
    { url: `${ORIGIN}/`, runScripts: "outside-only", resources: "usable" },
  );
  const { window } = dom;
  window.fetch = (url, init = {}) => fetch(url, { ...init, headers: { ...init.headers, Origin: ORIGIN } });
  const scriptEl = window.document.querySelector("script");
  Object.defineProperty(window.document, "currentScript", { value: scriptEl, configurable: true });
  Object.defineProperty(window.document, "readyState", { value: "complete", configurable: true });
  window.eval(readFileSync(new URL("public/widget.js", import.meta.url), "utf8"));
  await new Promise((r) => setTimeout(r, 1200));
  const styleText = window.document.getElementById("autochat365-widget-root").shadowRoot.querySelector("style").textContent;
  window.close();
  return styleText;
}

function extractRule(css, selector) {
  const match = css.match(new RegExp(selector.replace(/[.[\]]/g, "\\$&") + "\\s*\\{([^}]*)\\}"));
  if (!match) throw new Error(`rule ${selector} not found in CSS`);
  return match[1];
}

async function main() {
  const service = createClient(SUPABASE_URL, SERVICE_KEY);
  const { data: tenant } = await service.from("tenants").insert({ name: "Size Test Co" }).select("id").single();
  const { data: widget } = await service
    .from("widgets")
    .insert({ tenant_id: tenant.id, allowed_origins: [ORIGIN] })
    .select("id, site_key")
    .single();

  console.log("--- Default (0%/0%) renders the base sizes ---");
  {
    const css = await renderWidget(widget.site_key);
    const launcherRule = extractRule(css, ".launcher");
    const panelRule = extractRule(css, ".panel");
    assert(/width:\s*56px/.test(launcherRule), "launcher defaults to 56px wide");
    assert(/height:\s*56px/.test(launcherRule), "launcher defaults to 56px tall");
    assert(/width:\s*340px/.test(panelRule), "panel defaults to 340px wide");
    assert(/height:\s*480px/.test(panelRule), "panel defaults to 480px tall");
  }

  console.log("--- Icon scaled to +100%, window untouched -- only the launcher grows ---");
  {
    await service.from("widgets").update({ icon_scale_pct: 100, window_scale_pct: 0 }).eq("id", widget.id);
    const css = await renderWidget(widget.site_key);
    const launcherRule = extractRule(css, ".launcher");
    const svgRule = extractRule(css, ".launcher svg");
    const panelRule = extractRule(css, ".panel");
    assert(/width:\s*112px/.test(launcherRule), `launcher doubles to 112px at +100% (got: ${launcherRule})`);
    assert(/width:\s*52px/.test(svgRule), `launcher's inner icon scales proportionally to 52px (got: ${svgRule})`);
    assert(/width:\s*340px/.test(panelRule), "panel stays at its default 340px -- window size is untouched");
  }

  console.log("--- Window scaled to +50%, icon untouched -- only the panel grows ---");
  {
    await service.from("widgets").update({ icon_scale_pct: 0, window_scale_pct: 50 }).eq("id", widget.id);
    const css = await renderWidget(widget.site_key);
    const launcherRule = extractRule(css, ".launcher");
    const panelRule = extractRule(css, ".panel");
    assert(/width:\s*56px/.test(launcherRule), "launcher stays at its default 56px -- icon size is untouched");
    assert(/width:\s*510px/.test(panelRule), `panel grows to 510px at +50% (340 * 1.5) (got: ${panelRule})`);
    assert(/height:\s*720px/.test(panelRule), `panel height grows to 720px at +50% (480 * 1.5) (got: ${panelRule})`);
  }

  console.log("--- Both scaled independently at the same time ---");
  {
    await service.from("widgets").update({ icon_scale_pct: 25, window_scale_pct: 10 }).eq("id", widget.id);
    const css = await renderWidget(widget.site_key);
    const launcherRule = extractRule(css, ".launcher");
    const panelRule = extractRule(css, ".panel");
    assert(/width:\s*70px/.test(launcherRule), `launcher scales to 70px at +25% (56 * 1.25) (got: ${launcherRule})`);
    assert(/width:\s*374px/.test(panelRule), `panel scales to 374px at +10% (340 * 1.1) (got: ${panelRule})`);
  }

  console.log("--- The viewport-relative safety caps are untouched regardless of scale ---");
  {
    const css = await renderWidget(widget.site_key);
    const panelRule = extractRule(css, ".panel");
    assert(panelRule.includes("max-width: calc(100vw - 40px)"), "panel's viewport-relative max-width cap is still present");
    assert(panelRule.includes("max-height: calc(100vh - 120px)"), "panel's viewport-relative max-height cap is still present");
  }

  console.log("--- Real save flow: /api/widget-config reflects the saved percentages ---");
  {
    await service.from("widgets").update({ icon_scale_pct: 80, window_scale_pct: 35 }).eq("id", widget.id);
    const configRes = await fetch(`${API_BASE}/api/widget-config?site_key=${widget.site_key}`, { headers: { Origin: ORIGIN } });
    const config = await configRes.json();
    assert(config.icon_scale_pct === 80, `widget-config returns the saved icon_scale_pct (got ${config.icon_scale_pct})`);
    assert(config.window_scale_pct === 35, `widget-config returns the saved window_scale_pct (got ${config.window_scale_pct})`);
  }

  await service.from("tenants").delete().eq("id", tenant.id);
  console.log("\nALL WIDGET SIZE CHECKS PASSED");
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
