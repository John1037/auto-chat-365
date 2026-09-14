// A real browser's fetch() rejects a cross-origin response with a generic "Failed
// to fetch" if it lacks Access-Control-Allow-Origin -- even a perfectly well-formed
// JSON error body with the right status code. curl never enforces CORS at all, so it
// can't see this class of bug: every prior production check in this project was
// curl-based and structurally blind to it. This test checks the actual header on
// every error branch a cross-origin widget caller can hit across the three routes
// the embedded widget calls: session-start, chat, widget-config.
const API_BASE = "http://127.0.0.1:8787";
const ORIGIN = "https://jobsearch365.com";

function assert(cond, msg) {
  if (!cond) throw new Error("ASSERTION FAILED: " + msg);
  console.log("  ok:", msg);
}

async function checkCors(label, method, path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { Origin: ORIGIN, ...(body ? { "Content-Type": "application/json" } : {}) },
    body,
  });
  const allowOrigin = res.headers.get("Access-Control-Allow-Origin");
  console.log(`  ${label}: status ${res.status}, Access-Control-Allow-Origin: ${allowOrigin}`);
  assert(allowOrigin === ORIGIN, `${label} reflects the request Origin in Access-Control-Allow-Origin`);
}

async function main() {
  console.log("--- session-start error paths ---");
  await checkCors("unknown site_key (404)", "POST", "/api/session-start", JSON.stringify({ site_key: "sk_live_does_not_exist" }));
  await checkCors("invalid JSON body (400)", "POST", "/api/session-start", "not json");
  await checkCors("missing site_key (400)", "POST", "/api/session-start", JSON.stringify({}));

  console.log("--- chat error paths ---");
  await checkCors("no bearer token (401)", "POST", "/api/chat", JSON.stringify({ message: "hi" }));

  console.log("--- widget-config error paths ---");
  await checkCors("unknown site_key (404)", "GET", "/api/widget-config?site_key=sk_live_does_not_exist");
  await checkCors("missing site_key (400)", "GET", "/api/widget-config");

  console.log("\nALL CORS ERROR-PATH CHECKS PASSED");
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
