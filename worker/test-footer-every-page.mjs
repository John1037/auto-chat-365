// Confirms every page on the site -- public and dashboard alike -- serves a footer
// with working Privacy/Terms links, and that privacy.html/terms.html themselves are
// reachable with no auth at all (no cookies, no bearer token). Run against a live
// `wrangler dev`.
const API_BASE = process.argv[2] ?? "http://127.0.0.1:8787";

const PAGES = [
  "/", // serves index.html
  "/login.html",
  "/dashboard.html",
  "/widget-new.html",
  "/widget-settings.html",
  "/knowledge-base.html",
  "/knowledge-base-embed.html",
  "/knowledge-base-analysis.html",
  "/settings.html",
  "/privacy.html",
  "/terms.html",
];

function assert(cond, msg) {
  if (!cond) throw new Error("ASSERTION FAILED: " + msg);
  console.log("  ok:", msg);
}

async function main() {
  for (const path of PAGES) {
    // Deliberately no Authorization header and no cookies -- these must all be
    // reachable by a completely unauthenticated visitor (the dashboard pages
    // themselves gate their *data* client-side via requireSession(), not the static
    // HTML/footer, which must render before any session check can even run).
    const res = await fetch(`${API_BASE}${path}`);
    const html = await res.text();
    assert(res.status === 200, `${path}: served with no auth (status ${res.status})`);
    assert(html.includes('class="site-footer"'), `${path}: contains the site footer`);
    assert(html.includes('href="/privacy.html"') && html.includes(">Privacy Policy<"), `${path}: footer links to Privacy Policy`);
    assert(html.includes('href="/terms.html"') && html.includes(">Terms of Service<"), `${path}: footer links to Terms of Service`);
  }

  console.log("\nALL FOOTER-ON-EVERY-PAGE CHECKS PASSED");
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
