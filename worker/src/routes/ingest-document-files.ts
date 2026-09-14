import type { Env } from "../lib/env";
import { getServiceClient, getVerifiedUser, getBearerToken } from "../lib/supabase";
import { getOwnerTenantId } from "../lib/tenantOwner";
import { embedAndStoreDocument } from "../lib/embedDocument";
import { extractText } from "../lib/extractText";

const MAX_BYTES = 10 * 1024 * 1024; // 10MB per file
const ALLOWED_EXTENSIONS = new Set(["md", "txt", "docx"]);

interface FileResult {
  filename: string;
  ok: boolean;
  document_id?: string;
  error?: string;
}

function extensionOf(filename: string): string {
  return filename.toLowerCase().split(".").pop() ?? "";
}

// Multipart upload counterpart to ingest-document's JSON paste-text path -- one
// tenant_documents row per uploaded file, each independently chunked/embedded via
// the same embedAndStoreDocument used everywhere else. Processed sequentially (not
// in parallel) to stay well within the Worker's CPU-time budget and not blow past
// OpenAI's own rate limits when several files are uploaded at once. Failures are
// per-file, not all-or-nothing -- a bad file in the batch shouldn't roll back the
// good ones that already embedded successfully.
export async function handleIngestDocumentFiles(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const jwt = getBearerToken(request);
  const user = await getVerifiedUser(env, jwt);
  if (!user || user.isAnonymous) {
    return new Response(JSON.stringify({ error: "invalid or expired session" }), { status: 401 });
  }

  const tenantId = await getOwnerTenantId(env, user.id);
  if (!tenantId) {
    return new Response(JSON.stringify({ error: "no tenant found for this account" }), { status: 403 });
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return new Response(JSON.stringify({ error: "invalid form data" }), { status: 400 });
  }

  const files = formData.getAll("files").filter((entry): entry is File => typeof entry !== "string");
  if (files.length === 0) {
    return new Response(JSON.stringify({ error: "at least one file is required" }), { status: 400 });
  }

  const service = getServiceClient(env);
  const results: FileResult[] = [];

  for (const file of files) {
    const extension = extensionOf(file.name);
    if (!ALLOWED_EXTENSIONS.has(extension)) {
      results.push({ filename: file.name, ok: false, error: "unsupported file type -- only .md, .txt, .docx are allowed" });
      continue;
    }
    if (file.size > MAX_BYTES) {
      results.push({ filename: file.name, ok: false, error: "file is too large (10MB max)" });
      continue;
    }

    let content: string;
    try {
      content = (await extractText(file.name, await file.arrayBuffer())).trim();
    } catch {
      results.push({ filename: file.name, ok: false, error: "failed to read this file's contents" });
      continue;
    }
    if (!content) {
      results.push({ filename: file.name, ok: false, error: "file has no extractable text" });
      continue;
    }

    const title = file.name.replace(/\.[^./]+$/, "") || file.name;

    const { data: document, error: insertError } = await service
      .from("tenant_documents")
      .insert({
        tenant_id: tenantId,
        title,
        source_type: "upload",
        raw_content: content,
        status: "processing",
        created_by: user.id,
      })
      .select("id")
      .single();
    if (insertError || !document) {
      results.push({ filename: file.name, ok: false, error: "failed to create document" });
      continue;
    }

    const embedResult = await embedAndStoreDocument(env, service, tenantId, document.id, content);
    if (!embedResult.ok) {
      results.push({ filename: file.name, ok: false, document_id: document.id, error: embedResult.error });
      continue;
    }

    results.push({ filename: file.name, ok: true, document_id: document.id });
  }

  return new Response(JSON.stringify({ results }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
