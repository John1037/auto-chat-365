// Real-DOM verification that the built widget.js bundle actually consumes the
// widget's display config at runtime (position/color/title), not just that the
// worker API returns the right JSON shape. Run against a live `wrangler dev`.
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";

const API_BASE = process.argv[2];
const SITE_KEY = process.argv[3];
if (!API_BASE || !SITE_KEY) {
  console.error("usage: node test-runtime-config.mjs <apiBase> <siteKey>");
  process.exit(1);
}

const bundle = readFileSync(new URL("../worker/public/widget.js", import.meta.url), "utf8");

const dom = new JSDOM(
  `<!doctype html><html><body><script src="${API_BASE}/widget.js" data-site-key="${SITE_KEY}"></script></body></html>`,
  { url: "https://example.test/", runScripts: "outside-only", resources: "usable" },
);
const { window } = dom;
// Node's fetch doesn't auto-attach an Origin header the way a real browser does on
// cross-origin requests -- widget-config/session-start/chat all depend on that
// header being present (that's the whole isOriginAllowed enforcement), so the test
// harness has to fake what the browser would have sent.
window.fetch = (url, init = {}) =>
  fetch(url, { ...init, headers: { ...init.headers, Origin: "https://example.test" } });

const scriptEl = window.document.querySelector("script");
Object.defineProperty(window.document, "currentScript", { value: scriptEl, configurable: true });
Object.defineProperty(window.document, "readyState", { value: "complete", configurable: true });

window.eval(bundle);

// init() is async (awaits the widget-config fetch) -- give it a tick to finish
// before asserting on the DOM it produces.
await new Promise((resolve) => setTimeout(resolve, 1500));

function assert(cond, msg) {
  if (!cond) throw new Error("ASSERTION FAILED: " + msg);
  console.log("  ok:", msg);
}

const root = window.document.getElementById("autochat365-widget-root");
assert(!!root, "widget root element was created");
const shadow = root.shadowRoot;
assert(!!shadow, "shadow root attached");

const styleText = shadow.querySelector("style").textContent;
assert(styleText.includes("left: 32px"), "launcher positioned via fetched offset_x (32px, left side)");
assert(styleText.includes("bottom: 48px"), "launcher positioned via fetched offset_y (48px)");
assert(styleText.includes("#22aa55"), "accent color from fetched color_scheme applied to CSS");

const headerTitle = shadow.querySelector(".panel-header span").textContent;
assert(headerTitle === "Ask us anything", `panel header shows fetched chat_title (got "${headerTitle}")`);

console.log("\nALL RUNTIME CHECKS PASSED");
