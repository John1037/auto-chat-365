import type { Env } from "../lib/env";
import { getServiceClient, getVerifiedUser, getBearerToken } from "../lib/supabase";
import { getOwnerTenantId } from "../lib/tenantOwner";
import { embedAndInsertNewDocument } from "../lib/embedDocument";
import { extractText } from "../lib/extractText";
import { verifyOwnedWidgetIds } from "../lib/widgetVisibility";

const MAX_BYTES = 10 * 1024 * 1024; // 10MB per file
const ALLOWED_EXTENSIONS = new Set(["md", "txt", "docx"]);
// Cloudflare Workers cap total outgoing subrequests (Supabase + OpenAI calls, both
// count) for a single invocation -- 50 on the Free plan. Each file here costs 3
// (embed, insert document, insert chunks) plus ~2 for the auth checks up front and
// ~1 for the widget-visibility bulk insert at the end, so this stays comfortably
// under even that tightest limit. The client (knowledge-base-embed.ts) already
// sends files in batches at or under this size; this is a defensive floor for
// anyone calling the route directly.
const MAX_FILES_PER_REQUEST = 10;

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
// tenant_documents row per uploaded file. Processed sequentially (not in parallel)
// to stay within the Worker's CPU-time budget and not blow past OpenAI's own rate
// limits when several files are uploaded at once. Failures are per-file, not
// all-or-nothing -- a bad file in the batch shouldn't roll back the good ones that
// already embedded successfully.
//
// Visibility (is_global / widget_ids) applies to the whole batch, not per file --
// linking widgets is a single bulk insert after every file in the request has been
// created, not one insert per file, so a request's subrequest cost doesn't scale
// with both file count AND widget count at once.
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
  if (files.length > MAX_FILES_PER_REQUEST) {
    return new Response(JSON.stringify({ error: `too many files in one request (${MAX_FILES_PER_REQUEST} max)` }), { status: 400 });
  }

  const isGlobal = formData.get("is_global") !== "false"; // defaults to global if omitted, matching every document's existing default
  const requestedWidgetIds = formData.getAll("widget_ids").filter((entry): entry is string => typeof entry === "string");

  const service = getServiceClient(env);
  const ownedWidgetIds = isGlobal ? [] : await verifyOwnedWidgetIds(service, tenantId, requestedWidgetIds);

  const results: FileResult[] = [];
  const createdDocumentIds: string[] = [];

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

    const result = await embedAndInsertNewDocument(env, service, tenantId, user.id, title, content, isGlobal);
    if (!result.ok) {
      results.push({ filename: file.name, ok: false, error: result.error });
      continue;
    }

    results.push({ filename: file.name, ok: true, document_id: result.documentId });
    createdDocumentIds.push(result.documentId);
  }

  if (ownedWidgetIds.length > 0 && createdDocumentIds.length > 0) {
    const links = ownedWidgetIds.flatMap((widgetId) => createdDocumentIds.map((documentId) => ({ widget_id: widgetId, document_id: documentId })));
    const { error: linkError } = await service.from("widget_documents").insert(links);
    if (linkError) {
      // The documents themselves already embedded successfully -- failing safe to
      // visible-everywhere beats leaving them silently invisible to every widget.
      await service.from("tenant_documents").update({ is_global: true }).in("id", createdDocumentIds);
    }
  }

  return new Response(JSON.stringify({ results }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
