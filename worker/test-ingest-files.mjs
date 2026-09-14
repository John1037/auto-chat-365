// Verifies /api/ingest-document-files end to end: real .txt/.md/.docx uploads (the
// .docx is built in-memory below, matching real Word-shaped XML with a paragraph
// split across multiple runs), rejections (disallowed extension, oversized file),
// and that the extracted DOCX content is genuinely retrievable through a real chat
// round trip (not just "didn't error").
import { createClient } from "@supabase/supabase-js";
import { zipSync, strToU8 } from "fflate";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SERVICE_KEY = process.env.SUPABASE_SECRET_KEY;
const ANON_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;
const API_BASE = "http://127.0.0.1:8787";

function assert(cond, msg) {
  if (!cond) throw new Error("ASSERTION FAILED: " + msg);
  console.log("  ok:", msg);
}

// A minimal-but-real .docx (the standard OOXML skeleton), with a paragraph split
// across multiple <w:r> runs -- as real Word documents often are -- and an XML
// entity, to exercise both join-without-separator and unescaping.
function makeTestDocx() {
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;
  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>The secret ingredient is</w:t></w:r><w:r><w:t xml:space="preserve"> </w:t></w:r><w:r><w:t>saffron.</w:t></w:r></w:p>
    <w:p><w:r><w:t>It costs &amp;120 per gram.</w:t></w:r></w:p>
  </w:body>
</w:document>`;

  return zipSync({
    "[Content_Types].xml": strToU8(contentTypes),
    "_rels/.rels": strToU8(rootRels),
    "word/document.xml": strToU8(documentXml),
  });
}

async function main() {
  const admin = createClient(SUPABASE_URL, SERVICE_KEY);
  const email = `ingest-files-test-${Date.now()}@example.test`;
  const password = "test-password-123!";
  await admin.auth.admin.createUser({ email, password, email_confirm: true });
  const anon = createClient(SUPABASE_URL, ANON_KEY);
  const { data: signIn } = await anon.auth.signInWithPassword({ email, password });
  const accessToken = signIn.session.access_token;

  await fetch(`${API_BASE}/api/tenant-provision`, { method: "POST", headers: { Authorization: `Bearer ${accessToken}` } });

  console.log("--- Upload a mixed batch: .md, .txt, real .docx, disallowed .pdf, oversized .txt ---");
  const docxBytes = makeTestDocx();

  const body = new FormData();
  body.append("files", new Blob(["# Refund policy\n\nRefunds within 30 days."], { type: "text/markdown" }), "refunds.md");
  body.append("files", new Blob(["Store hours: 9am to 5pm, Monday to Friday."], { type: "text/plain" }), "hours.txt");
  body.append("files", new Blob([docxBytes], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }), "recipe.docx");
  body.append("files", new Blob(["fake pdf bytes"], { type: "application/pdf" }), "manual.pdf");
  body.append("files", new Blob([new Uint8Array(11 * 1024 * 1024)], { type: "text/plain" }), "huge.txt");

  const uploadRes = await fetch(`${API_BASE}/api/ingest-document-files`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
    body,
  });
  assert(uploadRes.ok, `request itself succeeds (${uploadRes.status})`);
  const { results } = await uploadRes.json();
  console.log("  results:", results);

  const byName = Object.fromEntries(results.map((r) => [r.filename, r]));
  assert(byName["refunds.md"].ok, ".md accepted and embedded");
  assert(byName["hours.txt"].ok, ".txt accepted and embedded");
  assert(byName["recipe.docx"].ok, ".docx accepted and embedded");
  assert(!byName["manual.pdf"].ok, ".pdf rejected");
  assert(/unsupported file type/i.test(byName["manual.pdf"].error), ".pdf rejection reason mentions unsupported file type");
  assert(!byName["huge.txt"].ok, "oversized file rejected");
  assert(/too large/i.test(byName["huge.txt"].error), "oversized rejection reason mentions size");

  console.log("--- The .docx's actual extracted text is correct (multi-run paragraph + XML entity) ---");
  const service = createClient(SUPABASE_URL, SERVICE_KEY);
  const { data: docxRow } = await service
    .from("tenant_documents")
    .select("raw_content, title, source_type, status")
    .eq("id", byName["recipe.docx"].document_id)
    .single();
  console.log("  extracted docx text:", JSON.stringify(docxRow.raw_content));
  assert(docxRow.title === "recipe", "title derived from filename without extension");
  assert(docxRow.source_type === "upload", "source_type recorded as upload");
  assert(docxRow.status === "ready", "docx document reached ready status");
  assert(docxRow.raw_content.includes("The secret ingredient is saffron."), "multi-run paragraph text joined correctly");
  assert(docxRow.raw_content.includes("It costs &120 per gram."), "XML entity (&amp;) unescaped correctly");

  console.log("--- Retrieval actually works: chat can answer from the uploaded .docx content ---");
  const { widget } = await (
    await fetch(`${API_BASE}/api/create-widget`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Ingest Test Widget" }),
    })
  ).json();
  await service.from("widgets").update({ allowed_origins: ["https://ingest-test.example"] }).eq("id", widget.id);

  const startRes = await fetch(`${API_BASE}/api/session-start`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://ingest-test.example" },
    body: JSON.stringify({ site_key: widget.site_key }),
  });
  const session = await startRes.json();
  const chatRes = await fetch(`${API_BASE}/api/chat`, {
    method: "POST",
    headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json", Origin: "https://ingest-test.example" },
    body: JSON.stringify({ message: "What is the secret ingredient? Answer in exactly one word." }),
  });
  const { reply } = await chatRes.json();
  console.log("  chat reply:", reply);
  assert(/saffron/i.test(reply), "chat correctly retrieves the fact from the uploaded .docx");

  console.log("\nALL FILE INGESTION CHECKS PASSED");
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
