import type { SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "./env";
import { chunkText } from "./chunk";
import { embedTexts } from "./openai";

// Shared by ingest-document (brand-new document) and reembed-document (re-run on
// edited content) -- chunk, embed, replace this document's chunks, and update its
// status. Deleting-then-reinserting chunks (rather than diffing) is simplest and
// correct either way: for a new document there's nothing to delete yet, for a
// re-embed the whole point is that the old chunks are no longer valid.
export async function embedAndStoreDocument(
  env: Env,
  service: SupabaseClient,
  tenantId: string,
  documentId: string,
  content: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const chunks = chunkText(content);
  if (chunks.length === 0) {
    return { ok: false, error: "document has no content to embed" };
  }

  try {
    const embeddings = await embedTexts(env, chunks);

    const { error: deleteError } = await service.from("tenant_document_chunks").delete().eq("document_id", documentId);
    if (deleteError) throw new Error(deleteError.message);

    const rows = chunks.map((chunkContent, index) => ({
      tenant_id: tenantId,
      document_id: documentId,
      chunk_index: index,
      content: chunkContent,
      embedding: embeddings[index],
    }));

    const { error: insertError } = await service.from("tenant_document_chunks").insert(rows);
    if (insertError) throw new Error(insertError.message);

    const { error: updateError } = await service
      .from("tenant_documents")
      .update({ status: "ready", embedded_at: new Date().toISOString() })
      .eq("id", documentId);
    if (updateError) throw new Error(updateError.message);

    return { ok: true };
  } catch (err) {
    await service.from("tenant_documents").update({ status: "error" }).eq("id", documentId);
    return { ok: false, error: err instanceof Error ? err.message : "embedding failed" };
  }
}

// A leaner path for ingest-document-files specifically: embedAndStoreDocument's
// insert-as-processing / update-to-ready split costs 2 extra subrequests per
// document (a delete of chunks that can't exist yet for a brand-new row, and a
// separate status update) that a batch upload can't afford -- Workers cap total
// subrequests per invocation, and a single request here handles many documents at
// once, not one. Embedding first means the document row can be inserted exactly
// once, already in its final state (chunks are inserted after, once the id exists).
// A failure before the row exists means nothing gets left behind for that file,
// which is fine here since the caller already reports success/failure per file.
export async function embedAndInsertNewDocument(
  env: Env,
  service: SupabaseClient,
  tenantId: string,
  userId: string,
  title: string,
  content: string,
  isGlobal: boolean,
): Promise<{ ok: true; documentId: string } | { ok: false; error: string }> {
  const chunks = chunkText(content);
  if (chunks.length === 0) {
    return { ok: false, error: "document has no content to embed" };
  }

  const embeddings = await embedTexts(env, chunks);

  const { data: document, error: insertError } = await service
    .from("tenant_documents")
    .insert({
      tenant_id: tenantId,
      title,
      source_type: "upload",
      raw_content: content,
      status: "ready",
      embedded_at: new Date().toISOString(),
      created_by: userId,
      is_global: isGlobal,
    })
    .select("id")
    .single();
  if (insertError || !document) {
    return { ok: false, error: "failed to create document" };
  }

  const rows = chunks.map((chunkContent, index) => ({
    tenant_id: tenantId,
    document_id: document.id,
    chunk_index: index,
    content: chunkContent,
    embedding: embeddings[index],
  }));
  const { error: chunksError } = await service.from("tenant_document_chunks").insert(rows);
  if (chunksError) {
    await service.from("tenant_documents").update({ status: "error" }).eq("id", document.id);
    return { ok: false, error: "failed to store embedded chunks" };
  }

  return { ok: true, documentId: document.id };
}
