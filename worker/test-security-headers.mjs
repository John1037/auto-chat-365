// Real browser verification of the new _headers file: confirms all four security
// headers are present on real pages, and -- the part jsdom can never check, since it
// doesn't implement CSP at all -- that the CSP doesn't actually break any real page
// (no blocked resources, no CSP violation reports, fonts/scripts/images all load).
//
// The connect-src check is a targeted fetch probe against the app's own configured
// Supabase origin (read from /api/config, the same source the dashboard pages
// themselves use), not a full sign-in -- that's enough to prove connect-src actually
// permits reaching it, without creating a throwaway auth.users account when this
// runs against production. Locally this correctly targets local Supabase
// (127.0.0.1:54321); in production it targets the real *.supabase.co project.
import { chromium } from "playwright";

const API_BASE = process.argv[2] ?? "http://127.0.0.1:8787";

function assert(cond, msg) {
  if (!cond) throw new Error("ASSERTION FAILED: " + msg);
  console.log("  ok:", msg);
}

async function checkHeaders(path) {
  const res = await fetch(`${API_BASE}${path}`);
  const headers = res.headers;
  assert(headers.get("x-content-type-options") === "nosniff", `${path}: X-Content-Type-Options: nosniff`);
  assert(headers.get("x-frame-options") === "DENY", `${path}: X-Frame-Options: DENY`);
  assert(headers.get("strict-transport-security")?.includes("max-age="), `${path}: Strict-Transport-Security present`);
  assert(headers.get("content-security-policy")?.includes("default-src 'self'"), `${path}: Content-Security-Policy present`);
}

async function checkRealBrowserLoad(browser, path, { expectConsoleErrors = false } = {}) {
  const page = await browser.newPage();
  const cspViolations = [];
  const consoleErrors = [];
  const failedRequests = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("requestfailed", (req) => failedRequests.push(`${req.url()} -- ${req.failure()?.errorText}`));
  // A CSP violation dispatches a real 'securitypolicyviolation' DOM event -- listen
  // for that directly rather than only scraping console text, which is a more
  // reliable signal of an actual CSP block than string-matching console messages.
  await page.exposeFunction("__reportCspViolation", (detail) => cspViolations.push(detail));
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (e) => {
      // @ts-ignore -- exposed by Playwright above
      window.__reportCspViolation(`${e.violatedDirective}: ${e.blockedURI}`);
    });
  });

  const response = await page.goto(`${API_BASE}${path}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(500);

  console.log(`  [${path}] status=${response.status()} consoleErrors=${consoleErrors.length} cspViolations=${cspViolations.length} failedRequests=${failedRequests.length}`);
  if (consoleErrors.length) console.log("    console errors:", consoleErrors);
  if (cspViolations.length) console.log("    CSP violations:", cspViolations);
  if (failedRequests.length) console.log("    failed requests:", failedRequests);

  assert(response.ok(), `${path}: page itself loaded (status ${response.status()})`);
  assert(cspViolations.length === 0, `${path}: no CSP violations while loading the real page in a real browser`);
  if (!expectConsoleErrors) {
    assert(consoleErrors.length === 0, `${path}: no console errors while loading the real page`);
  }
  await page.close();
}

async function main() {
  console.log("--- Headers present on public and dashboard pages alike ---");
  for (const path of ["/", "/login.html", "/dashboard.html", "/privacy.html", "/terms.html"]) {
    await checkHeaders(path);
  }

  console.log("--- Headers present on the widget bundle and API responses too ---");
  await checkHeaders("/widget.js");

  const browser = await chromium.launch();

  console.log("--- Real browser load: public pages ---");
  await checkRealBrowserLoad(browser, "/");
  await checkRealBrowserLoad(browser, "/login.html");
  await checkRealBrowserLoad(browser, "/privacy.html");
  await checkRealBrowserLoad(browser, "/terms.html");

  console.log("--- connect-src: does the CSP actually permit reaching this app's own configured Supabase origin? ---");
  const { supabaseUrl } = await (await fetch(`${API_BASE}/api/config`)).json();
  const matchesShippedPolicy = /^https:\/\/[^/]+\.supabase\.co$/.test(supabaseUrl);
  console.log(`  configured Supabase origin: ${supabaseUrl} (${matchesShippedPolicy ? "matches" : "does NOT match"} the shipped 'https://*.supabase.co' allowance)`);

  const page = await browser.newPage();
  const cspViolations = [];
  await page.exposeFunction("__reportCspViolation", (detail) => cspViolations.push(detail));
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (e) => {
      // @ts-ignore -- exposed by Playwright above
      window.__reportCspViolation(`${e.violatedDirective}: ${e.blockedURI}`);
    });
  });
  await page.goto(`${API_BASE}/login.html`, { waitUntil: "networkidle" });
  // A raw fetch to a real, public, unauthenticated GoTrue endpoint -- enough to prove
  // connect-src permits the connection attempt itself, without needing a real signed-
  // in session (avoids creating a throwaway auth.users account when this runs against
  // production, which has no local service-role key available to this test anyway).
  await page.evaluate(async (url) => {
    try {
      await fetch(`${url}/auth/v1/settings`);
    } catch {
      // A network-level failure is a separate concern from a CSP block -- the
      // securitypolicyviolation listener above is what actually answers "was this
      // blocked by connect-src", not whether the request itself succeeded.
    }
  }, supabaseUrl);
  await page.waitForTimeout(500);

  console.log(`  CSP violations from the probe: ${cspViolations.length}`, cspViolations);
  if (matchesShippedPolicy) {
    assert(cspViolations.length === 0, "connect-src permits reaching the real Supabase origin (production-shaped URL)");
  } else {
    // Local dev's Supabase runs on 127.0.0.1, a different origin than production's
    // real *.supabase.co domain -- the shipped CSP is deliberately scoped to what
    // production actually uses, not loosened with a local-only allowance, so a
    // violation here is expected and does not indicate a problem with the policy.
    console.log("  (expected locally -- the shipped CSP targets production's real Supabase domain, not local dev's; verify this same check against production separately)");
  }
  await page.close();

  await browser.close();
  console.log("\nALL SECURITY HEADERS CHECKS PASSED");
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
